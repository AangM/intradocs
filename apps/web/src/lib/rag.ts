import 'server-only';
import { cache } from 'react';
import type { Actor } from '@intradocs/core';
import {
  readAiConfig,
  describeAiConfig,
  type AiConfig,
  type AiStatus,
} from '@intradocs/core/ai-config';
import { WeknoraClient } from '@intradocs/core/weknora';
import {
  gateByRelevance,
  validateRetrieval,
  ABSTAIN_MESSAGE,
  resolveGeneratedAnswer,
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
import { storeTurn } from '@intradocs/db/assistant';
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
}

/**
 * Answers only from validated citations. When nothing survives validation the model is
 * never asked: an abstention is returned instead, so there is no path where an answer
 * exists without evidence behind it.
 */
export async function answerQuestion(
  actor: Actor,
  question: string,
  within: RetrievalScope = { type: 'all' },
  conversationId: string | null = null,
): Promise<ChatResult> {
  const config = getAiConfig();
  const weknora = requireEnabled(config);
  const retrieval = await retrieve(actor, question, within);
  const mode: ChatResult['mode'] =
    config.generation === 'weknora-local' ? 'generated' : 'evidence-only';
  const shape = { mode, scopeSize: retrieval.scopeSize, rejectedCount: retrieval.rejectedCount };
  // History lives in IntraDocs, one row per turn, after the turn is fully validated.
  // Every turn still retrieves on its own: an earlier answer never feeds a later one, so
  // a permission change takes effect on the very next message.
  const remember = async (
    turn: Omit<ChatResult, 'conversationId' | 'turnId'>,
  ): Promise<ChatResult> => {
    const stored = await storeTurn(actor.id, conversationId, { ...turn, question, scope: within });
    return { ...turn, conversationId: stored.conversationId, turnId: stored.turnId };
  };
  if (retrieval.citations.length === 0)
    return remember({ ...shape, answer: ABSTAIN_MESSAGE, citations: [], abstained: true });
  if (mode !== 'generated') {
    // Retrieval-only mode: sources are shown without a generated answer rather than
    // falling back to any other provider.
    return remember({ ...shape, answer: '', citations: retrieval.citations, abstained: false });
  }
  const client = new WeknoraClient(weknora);
  // A fresh session per turn: no cross-request memory lives in WeKnora, so nothing
  // leaks between users and no earlier answer survives a permission change.
  const sessionId = await client.createSession(`intradocs-${Date.now()}`);
  let answer: Awaited<ReturnType<WeknoraClient['knowledgeChat']>>;
  try {
    answer = await client.knowledgeChat(sessionId, {
      query: question,
      knowledgeIds: retrieval.knowledgeIds,
    });
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
  }
  await recordRagAudit(
    actor.id,
    'rag.chat',
    retrieval.citations.map((c) => c.documentId),
  );
  return remember({
    ...shape,
    answer: resolveGeneratedAnswer(answer.answer).answer,
    citations: retrieval.citations,
    abstained: false,
  });
}
