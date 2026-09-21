import 'server-only';
import { cache } from 'react';
import type { Actor } from '@intradocs/core';
import {
  readAiConfig,
  describeAiConfig,
  type AiConfig,
  type AiStatus,
} from '@intradocs/core/ai-config';
import { WeknoraClient, createKbTagFilter } from '@intradocs/core/weknora';
import {
  gateByRelevance,
  validateRetrieval,
  ABSTAIN_MESSAGE,
  resolveGeneratedAnswer,
  salvageDecline,
  isContinuation,
  classifyIntent,
  detectConflicts,
  type AssistantIntent,
  type SourceConflict,
  type Citation,
  type RawHit,
  type RetrievalScope,
} from '@intradocs/core/rag';
import {
  listAuthorizedSources,
  resolveAuthorizedSources,
  readAuthorizedMarkdownKeys,
  recordRagAudit,
} from '@intradocs/db/rag';
import {
  storeTurn,
  conversationContext,
  setConversationSession,
  relatedDocuments,
  type RelatedDocument,
} from '@intradocs/db/assistant';
import { getStorage } from './storage.ts';

/**
 * Server-side RAG surface.
 *
 * The API key, base URL and knowledge base ID are read here and never leave the server:
 * no route echoes them, and the client never chooses them. A request is answered only
 * from sources this actor may read at this instant.
 */
export const getAiConfig = cache((): AiConfig => readAiConfig(process.env));

export function aiStatus(): AiStatus {
  return describeAiConfig(getAiConfig());
}

export class AiDisabled extends Error {}

function requireEnabled(config: AiConfig) {
  if (config.retrieval !== 'weknora-local' || !config.weknora)
    throw new AiDisabled('Asisten AI belum diaktifkan pada instalasi ini.');
  return config.weknora;
}

export interface RetrievalResult {
  citations: Citation[];
  /** WeKnora IDs behind the validated citations; the only IDs generation may see. */
  knowledgeIds: string[];
  rejectedCount: number;
  scopeSize: number;
}

/**
 * Retrieval in three movements: decide the scope from the database, ask WeKnora only
 * within that scope, then re-read the database for whatever came back. The last step is
 * not redundant — a grant revoked while WeKnora was answering fails closed here.
 */
export async function retrieve(
  actor: Actor,
  question: string,
  within: RetrievalScope = { type: 'all' },
): Promise<RetrievalResult> {
  const config = getAiConfig();
  const weknora = requireEnabled(config);
  const scope = await listAuthorizedSources(actor.id, weknora.maxScopeDocuments, within);
  if (scope.length === 0) {
    await recordRagAudit(actor.id, 'rag.abstained');
    return { citations: [], knowledgeIds: [], rejectedCount: 0, scopeSize: 0 };
  }
  const client = new WeknoraClient(weknora);
  const request = {
    knowledgeIds: scope.map((s) => s.knowledgeId),
    queryText: question,
    // Headroom for what the gate will throw away: with summary generation on, WeKnora
    // ranks one generated `summary` chunk per document among the real ones, and with
    // maxCandidates alone those took four of six slots and pushed a gold document out
    // (rag:eval a19). Citations are still capped at maxCitations after validation.
    matchCount: Math.min(weknora.maxCandidates * 2, 40),
  };
  // Two passes over the same scope: the fused ranking for recall, a vector-only pass for
  // a similarity the fused score does not carry. The gate joins them; see gateByRelevance.
  const [hybrid, vectorOnly] = await Promise.all([
    client.hybridSearch(request),
    weknora.minRelevance > 0
      ? client.hybridSearch({ ...request, disableKeywordsMatch: true })
      : Promise.resolve([]),
  ]);
  const gated = gateByRelevance(hybrid, vectorOnly, weknora.minRelevance);
  const hits: RawHit[] = gated.kept;
  const allowed = await resolveAuthorizedSources(
    actor.id,
    hits.map((h) => h.knowledgeId),
  );
  const markdownByVersion = await loadMarkdown(actor, allowed, hits);
  const validated = validateRetrieval(hits, allowed, {
    maxSnippetChars: weknora.maxSnippetChars,
    maxCitations: 6,
    markdownByVersion,
  });
  await recordRagAudit(
    actor.id,
    validated.citations.length ? 'rag.retrieval' : 'rag.abstained',
    validated.citations.map((c) => c.documentId),
  );
  if (validated.rejected.length) await recordRagAudit(actor.id, 'rag.citation_rejected');
  // Map back through `allowed`, so generation is pinned to the same revalidated set the
  // citations came from rather than to anything WeKnora offered.
  const knowledgeByVersion = new Map(
    [...allowed.values()].map((s) => [s.versionId, s.knowledgeId]),
  );
  return {
    citations: validated.citations,
    knowledgeIds: validated.citations
      .map((c) => knowledgeByVersion.get(c.versionId))
      .filter((id): id is string => typeof id === 'string'),
    rejectedCount: validated.rejected.length,
    scopeSize: scope.length,
  };
}

/** Markdown for cited versions only, so a locator is resolved without reading the corpus. */
async function loadMarkdown(
  actor: Actor,
  allowed: Map<string, { versionId: string }>,
  hits: readonly RawHit[],
): Promise<Map<string, string>> {
  const versionIds = [...new Set(hits.map((h) => allowed.get(h.knowledgeId)?.versionId))].filter(
    (id): id is string => typeof id === 'string',
  );
  const keys = await readAuthorizedMarkdownKeys(actor.id, versionIds.slice(0, 6));
  const storage = getStorage();
  const out = new Map<string, string>();
  for (const k of keys) {
    try {
      const bytes = await storage.read(k.key, k.hash);
      out.set(k.versionId, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      // A missing or corrupt artifact costs an anchor, never the whole answer.
    }
  }
  return out;
}

export interface ChatResult {
  answer: string;
  citations: Citation[];
  abstained: boolean;
  /** Composed by a model, or sources only. */
  mode: 'generated' | 'evidence-only';
  /** Same numbers retrieval reports, so the UI can say how wide the search was. */
  scopeSize: number;
  rejectedCount: number;
  /** The IntraDocs-side thread this turn was appended to, and the stored turn. */
  conversationId: string;
  turnId: string;
  /**
   * Documents worth opening next: the catalogue behind a "what else is there" question,
   * or the nearest matches beside an abstention. Always from RLS-filtered rows; not
   * stored with the turn (the answer text names them, the links are a convenience).
   */
  related: RelatedLink[];
  /** Questions the person can ask next, generated at ingest for the documents in play. */
  suggestions: string[];
  /** Quantities that the cited documents state differently (PRD §3.4); see detectConflicts. */
  conflicts: SourceConflict[];
}

export interface RelatedLink {
  documentId: string;
  title: string;
  categoryName: string;
  href: string;
}

const relatedLink = (d: RelatedDocument): RelatedLink => ({
  documentId: d.documentId,
  title: d.title,
  categoryName: d.categoryName,
  href: `/dokumen/${d.documentId}/${encodeURIComponent(d.slug)}`,
});

/**
 * Follow-up questions from what WeKnora generated at ingest for the given knowledge
 * ids -- two documents, a few questions, the one just asked left out. Any failure is an
 * empty list: suggestions are never worth an error.
 */
async function suggestionsFor(
  client: WeknoraClient,
  knowledgeIds: readonly string[],
  exclude: string,
  max = 3,
): Promise<string[]> {
  const out: string[] = [];
  const norm = (q: string) =>
    q
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  for (const id of [...new Set(knowledgeIds)].slice(0, 2)) {
    const generated = await client
      .knowledgeGenerated(id, { maxSummaryChars: 0, maxQuestions: 4 })
      .catch(() => null);
    for (const raw of generated?.questions ?? []) {
      const q = tidyQuestion(raw);
      if (q && norm(q) !== norm(exclude) && !out.some((x) => norm(x) === norm(q))) out.push(q);
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/**
 * Generated questions are written against a chunk ("... sesuai petunjuk di dokumen
 * ini?", "... seperti yang dinyatakan di konteks ini?"); as a chip that reads oddly.
 * The trailing reference to "this document/context" is dropped, and a question that is
 * still long or that speculates about who wrote the policy is skipped.
 */
function tidyQuestion(raw: string): string | null {
  let q = raw.replace(/\s+/g, ' ').trim();
  q = q.replace(
    /,?\s*(?:(?:seperti|sebagaimana)\s+)?(?:yang\s+)?(?:dinyatakan|disebutkan|dijelaskan|ditetapkan|tercantum|dibahas|diuraikan)?\s*(?:di|dalam|pada|menurut|sesuai(?:\s+dengan)?(?:\s+petunjuk)?(?:\s+di)?)\s+(?:konteks|dokumen|panduan|materi|teks|kebijakan)\s+(?:ini|tersebut|di atas)\s*\?$/iu,
    '?',
  );
  q = q.replace(/\s+\?$/, '?');
  if (!q.endsWith('?')) q += '?';
  if (q.length < 12 || q.length > 110) return null;
  if (/\b(kementerian|penulis|siapa yang menulis)\b/i.test(q)) return null;
  return q.charAt(0).toUpperCase() + q.slice(1);
}

/**
 * The passage worth quoting under a decline: the citation that shares the most words
 * with the question, a section passage preferred over the document's head (whose
 * "heading" is the title and whose text is mostly boilerplate), then by relevance.
 */
function nearestCitation(question: string, citations: readonly Citation[]): Citation | undefined {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  const overlapOf = (c: Citation) => {
    const text = c.snippet.toLowerCase();
    return words.filter((w) => text.includes(w)).length;
  };
  const score = (c: Citation) => {
    const section = c.heading && c.heading !== c.documentTitle ? 1 : 0;
    return overlapOf(c) * 10 + section * 5 + (c.relevance ?? 0);
  };
  const best = [...citations].sort((a, b) => score(b) - score(a))[0];
  // A passage that shares no word with the question is not "nearest", just listed.
  return best && overlapOf(best) > 0 ? best : undefined;
}

/**
 * The fallback sentence, what the model said the material does say (if anything), and
 * the nearest passage as a verbatim quote, cut at a sentence.
 */
function withNearestPassage(
  question: string,
  message: string,
  remainder: string,
  top: Citation | undefined,
): string {
  const said = remainder ? `\n\nYang disebutkan materi: ${remainder.slice(0, 500)}` : '';
  if (!top) return message + said;
  const where = `**${top.documentTitle}**${top.heading ? ` › ${top.heading}` : ''}`;
  return `${message}${said}\n\nBagian terdekat, dari ${where}:\n> ${excerptAround(question, top.snippet)}`;
}

/**
 * Up to ~420 characters of a passage, starting at the sentence that first mentions one of
 * the question's words -- so the sentence that matters ("Jangan menonaktifkan kontrol
 * keamanan ...") is in the quote even when it sits at the end of a long section.
 */
function excerptAround(question: string, passage: string): string {
  const text = passage.replace(/\s+/g, ' ').trim();
  if (text.length <= 420) return text;
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  // The sentence sharing the most words with the question opens the window; a
  // section's first sentences are often preamble and the answer sits further down.
  let start = 0;
  let bestHits = 0;
  for (const m of text.matchAll(/[^.;]+[.;]?/g)) {
    const sentence = m[0].toLowerCase();
    const hits = words.filter((w) => sentence.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      start = m.index;
    }
  }
  // Keep the whole thing from the start when the best sentence is early anyway.
  if (start < 140) start = 0;
  let cut = text.slice(start, start + 420);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  cut = end > 120 ? cut.slice(0, end + 1) : cut;
  return `${start > 0 ? '… ' : ''}${cut}${start + cut.length < text.length ? ' …' : ''}`;
}

/** A fixed, honest reply for a message that is about the assistant, not a document. */
function intentAnswer(intent: AssistantIntent, docs: RelatedDocument[], total: number): string {
  if (intent === 'greeting')
    return 'Halo! Saya asisten IntraDocs. Tanyakan apa saja tentang SOP, panduan, dan kebijakan — saya menjawab dari dokumen resmi yang boleh Anda baca dan selalu menyebut sumbernya.';
  if (intent === 'thanks')
    return 'Sama-sama. Kalau ada pertanyaan lain tentang dokumen, tanyakan saja di sini.';
  if (intent === 'capabilities')
    return [
      'Yang bisa saya lakukan:',
      '- Menjawab pertanyaan dari isi dokumen resmi yang boleh Anda baca, dengan sumber yang bisa dibuka.',
      '- Memahami pertanyaan lanjutan dalam percakapan yang sama ("jelaskan lebih lengkap", "kalau gagal bagaimana?").',
      '- Menunjukkan dokumen apa saja yang tersedia untuk Anda, atau yang terkait suatu topik.',
      '',
      'Yang tidak saya lakukan: menjawab dari pengetahuan umum atau menebak. Kalau dokumennya tidak ada, saya bilang tidak ada — lalu menunjukkan dokumen terdekat.',
    ].join('\n');
  if (docs.length === 0)
    return total === 0
      ? 'Belum ada dokumen terbit yang boleh Anda baca. Kalau Anda menunggu dokumen tertentu, minta akses lewat menu Permintaan Akses.'
      : 'Tidak ada dokumen yang cocok dengan topik itu di cakupan Anda. Coba kata lain, atau tanyakan "dokumen apa saja yang ada?".';
  const lines = docs.map((d) => `- **${d.title}** — ${d.summary} (${d.categoryName})`);
  const head =
    docs.length < total
      ? `Ada ${total} dokumen yang boleh Anda baca. Yang paling relevan:`
      : `Ada ${total} dokumen yang boleh Anda baca:`;
  return [head, ...lines, '', 'Buka salah satunya di bawah, atau tanyakan isinya langsung.'].join(
    '\n',
  );
}

/**
 * Answers only from validated citations. When nothing survives validation the model is
 * never asked: an abstention is returned instead, so there is no path where an answer
 * exists without evidence behind it.
 */
/**
 * Progress a streaming caller can show while a turn is in flight. `delta` carries
 * answer fragments as the model writes them -- a preview: WeKnora's citation markup is
 * filtered out, but the text is otherwise unvalidated and is replaced by the final
 * ChatResult, which alone is stored and cited. Retrieval and validation have already
 * finished before the first delta, so a fragment can only come from passages the
 * actor may read.
 */
export interface AnswerHooks {
  status?: (stage: 'retrieving' | 'generating') => void;
  delta?: (text: string) => void;
}

export async function answerQuestion(
  actor: Actor,
  question: string,
  within: RetrievalScope = { type: 'all' },
  conversationId: string | null = null,
  hooks: AnswerHooks = {},
): Promise<ChatResult> {
  const config = getAiConfig();
  const weknora = requireEnabled(config);
  const mode: ChatResult['mode'] =
    config.generation === 'weknora-local' ? 'generated' : 'evidence-only';
  // History lives in IntraDocs, one row per turn, after the turn is fully validated.
  // Every turn still retrieves on its own: an earlier answer never feeds a later one, so
  // a permission change takes effect on the very next message.
  const remember = async (
    turn: Omit<ChatResult, 'conversationId' | 'turnId'>,
  ): Promise<ChatResult> => {
    const stored = await storeTurn(actor.id, conversationId, { ...turn, question, scope: within });
    return { ...turn, conversationId: stored.conversationId, turnId: stored.turnId };
  };
  // A message about the assistant or the catalogue never reaches retrieval or the
  // model: the reply is fixed text or a list of documents this person may read.
  const intent = classifyIntent(question);
  if (intent) {
    const client = new WeknoraClient(weknora);
    const catalogue = intent === 'catalog' ? await relatedDocuments(actor.id, question, 6) : [];
    // A topical catalogue question that matched nothing falls back to the newest docs.
    const docs =
      intent === 'catalog' && catalogue.length === 0
        ? await relatedDocuments(actor.id, '', 6)
        : catalogue;
    const total = intent === 'catalog' ? (await relatedDocuments(actor.id, '', 200)).length : 0;
    const suggestions =
      intent === 'thanks'
        ? []
        : await suggestionsFor(
            client,
            (docs.length ? docs : await relatedDocuments(actor.id, '', 3))
              .map((d) => d.knowledgeId)
              .filter((k): k is string => !!k),
            question,
          );
    return remember({
      mode,
      scopeSize: total,
      rejectedCount: 0,
      answer: intentAnswer(intent, docs, total),
      citations: [],
      abstained: false,
      related: intent === 'catalog' ? docs.map(relatedLink) : [],
      suggestions,
      conflicts: [],
    });
  }
  // Conversational context, when this turn continues a conversation: the WeKnora
  // session to keep talking in -- null when there is none yet, or when an earlier turn
  // cites a version the person can no longer read (then the old one is forgotten and
  // deleted before anything else happens this turn, even if this turn abstains).
  const context = conversationId
    ? await conversationContext(actor.id, conversationId)
    : { sessionId: null, staleSessionId: null, previousQuestion: null };
  if (conversationId && context.staleSessionId) {
    await setConversationSession(actor.id, conversationId, null);
    await new WeknoraClient(weknora).deleteSession(context.staleSessionId).catch(() => undefined);
  }
  // Retrieval is on this question alone, every turn -- with one narrow exception. A
  // follow-up made only of continuation words ("jelaskan lebih lengkap", "kenapa?")
  // names nothing: on its own it either abstains mid-conversation or, worse, matches
  // whichever documents happen to contain "jelaskan" and "lengkap" and gets an answer
  // about those. For that shape the retrieval runs on the previous question of the same
  // conversation (the last one answered from sources) instead -- same scope, same gate,
  // this person's permissions right now -- so the model elaborates on what it just
  // answered; if that finds nothing any more, the turn abstains rather than falling
  // back to the word-matches. Blindly concatenating the previous question was tried and
  // dropped: it made "berapa harga saham?" inherit the VPN sources and stop abstaining.
  const continuation =
    !!context.previousQuestion && context.previousQuestion !== question && isContinuation(question);
  hooks.status?.('retrieving');
  const retrieval = await retrieve(
    actor,
    continuation ? (context.previousQuestion as string) : question,
    within,
  );
  const shape = { mode, scopeSize: retrieval.scopeSize, rejectedCount: retrieval.rejectedCount };
  const client = new WeknoraClient(weknora);
  if (retrieval.citations.length === 0) {
    // An abstention still helps: the nearest documents by their own words (title,
    // summary, indexed text -- RLS-filtered, nothing logged) and questions those
    // documents can answer, so the person has somewhere to go instead of a wall.
    const near = await relatedDocuments(actor.id, question, 3);
    return remember({
      ...shape,
      answer: ABSTAIN_MESSAGE,
      citations: [],
      abstained: true,
      related: near.map(relatedLink),
      suggestions: await suggestionsFor(
        client,
        near.map((d) => d.knowledgeId).filter((k): k is string => !!k),
        question,
      ),
      conflicts: [],
    });
  }
  if (mode !== 'generated') {
    // Retrieval-only mode: sources are shown without a generated answer rather than
    // falling back to any other provider.
    return remember({
      ...shape,
      answer: '',
      citations: retrieval.citations,
      abstained: false,
      related: [],
      suggestions: [],
      conflicts: detectConflicts(question, retrieval.citations),
    });
  }
  // One WeKnora session per conversation, so the model can read this person's own
  // earlier turns. Every generated turn belongs to a conversation (storeTurn opens one
  // for a first question), so the session outlives the turn and is stored on it below;
  // it is never shared between people, retrieval stays scoped per turn, and the stored
  // session is dropped when an earlier citation became unreadable (conversationContext).
  // It is deleted in WeKnora when the person deletes the conversation.
  const sessionId = context.sessionId ?? (await client.createSession(`intradocs-${Date.now()}`));
  let answer: Awaited<ReturnType<WeknoraClient['knowledgeChat']>>;
  hooks.status?.('generating');
  const preview = hooks.delta ? createKbTagFilter() : null;
  try {
    answer = await client.knowledgeChat(
      sessionId,
      { query: question, knowledgeIds: retrieval.knowledgeIds },
      preview
        ? (fragment) => {
            const text = preview.push(fragment);
            if (text) hooks.delta?.(text);
          }
        : undefined,
    );
  } catch (error) {
    // A session WeKnora no longer knows (restart, retention) is not an answer failure:
    // forget it so the next turn starts a fresh one.
    if (conversationId && context.sessionId)
      await setConversationSession(actor.id, conversationId, null).catch(() => undefined);
    throw error;
  }
  // Corpus text in a log line: only on an explicit switch, for a synthetic corpus.
  if (process.env.RAG_DEBUG === '1')
    console.log(
      `[rag] refs=${answer.references.length} raw=${JSON.stringify(answer.answer.slice(0, 400))}`,
    );
  await recordRagAudit(
    actor.id,
    'rag.chat',
    retrieval.citations.map((c) => c.documentId),
  );
  const resolved = resolveGeneratedAnswer(answer.answer);
  // A decline followed by the answer itself (salvageDecline) is shown as the answer.
  // A decline that stays a decline gets the nearest passage quoted right here: a 3B
  // model sometimes says "tidak membahas" about the very sentence that answers, and the
  // person should not have to open the document to find that sentence.
  const salvaged = resolved.fellBack ? salvageDecline(question, resolved.remainder) : null;
  const stored = await remember({
    ...shape,
    answer: salvaged
      ? salvaged
      : resolved.fellBack
        ? withNearestPassage(
            question,
            resolved.answer,
            resolved.remainder,
            nearestCitation(question, retrieval.citations),
          )
        : resolved.answer,
    citations: retrieval.citations,
    abstained: false,
    related: [],
    suggestions: await suggestionsFor(client, retrieval.knowledgeIds, question),
    conflicts: detectConflicts(question, retrieval.citations),
  });
  // Remember the session on the conversation this turn now belongs to (a first turn
  // creates the conversation inside remember); a replaced session overwrites the old one.
  if (context.sessionId !== sessionId)
    await setConversationSession(actor.id, stored.conversationId, sessionId).catch(() => undefined);
  return stored;
}
