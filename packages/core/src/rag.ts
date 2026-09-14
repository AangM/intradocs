// Pure RAG policy: export shaping, idempotency planning, citation validation and
// locator resolution. No I/O, no network, no database — so every rule below is
// unit-testable offline and cannot be softened by a live service being agreeable.
import { createHash } from 'node:crypto';
import { headingSlug, InputError, parseUuid } from './validation.ts';
import {
  ABSTAIN_MESSAGE,
  NO_DIRECT_ANSWER_MESSAGE,
  MODEL_DECLINE_PATTERN,
} from './rag-messages.ts';

/**
 * Bumping this forces every version to be re-exported on the next sync. Change it
 * when the payload format below changes, so an index built by an older pipeline is
 * replaced rather than silently kept.
 */
export const PIPELINE_REVISION = 'm4-manual-md-1';

/** Marker that makes a WeKnora record traceable back to one IntraDocs version. */
export const INDEX_TITLE_PREFIX = 'IntraDocs';

export function indexTitle(versionId: string, documentTitle: string): string {
  return `[${INDEX_TITLE_PREFIX}:${versionId}] ${documentTitle}`.slice(0, 300);
}

/** Recovers the version a WeKnora record claims to carry. Claim, not proof. */
export function versionIdFromIndexTitle(title: string): string | null {
  const match = /^\[IntraDocs:([0-9a-fA-F-]{36})\]/.exec(title);
  return match ? match[1]!.toLowerCase() : null;
}

export interface ExportSource {
  documentId: string;
  versionId: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  markdown: string;
}

export interface ExportPayload {
  title: string;
  content: string;
}

/**
 * Body sent to WeKnora. The provenance header is metadata for a human inspecting the
 * index; it carries no identity, no grant list and no instruction. Document text is
 * copied verbatim: any instruction inside it is data that the retrieval and chat
 * layers refuse to act on, and no preamble here is relied on for that.
 */
export function buildExportPayload(source: ExportSource): ExportPayload {
  const header = [
    `<!-- intradocs:document=${source.documentId} version=${source.versionId} -->`,
    `> Sumber: IntraDocs · ${source.categoryName} · versi ${source.versionLabel} · klasifikasi ${source.classification}.`,
    '',
  ].join('\n');
  return {
    title: indexTitle(source.versionId, source.documentTitle),
    content: header + source.markdown,
  };
}

/**
 * Identity of one exported payload. Derived from the version's content hash plus the
 * metadata that ends up in the payload header, so a retitled or reclassified document
 * is re-exported while an unchanged one is skipped without reading its file.
 */
export function exportContentHash(
  source: Omit<ExportSource, 'markdown'> & { markdownSha256: string },
): string {
  return createHash('sha256')
    .update(
      // JSON, not a raw delimiter: a title containing the separator must never be
      // able to collide with a different set of fields.
      JSON.stringify([
        PIPELINE_REVISION,
        source.versionId,
        source.markdownSha256,
        source.documentTitle,
        source.versionLabel,
        source.classification,
        source.categoryName,
      ]),
    )
    .digest('hex');
}

export type IndexState = 'pending' | 'indexed' | 'failed' | 'revoked';

export interface IndexEntry {
  versionId: string;
  documentId: string;
  knowledgeId: string | null;
  contentSha256: string;
  state: IndexState;
  attempts: number;
}

export interface DesiredVersion {
  versionId: string;
  documentId: string;
  contentSha256: string;
}

export type ExportAction =
  | { kind: 'create'; versionId: string; documentId: string; contentSha256: string }
  | {
      kind: 'update';
      versionId: string;
      documentId: string;
      contentSha256: string;
      knowledgeId: string;
    }
  | { kind: 'reconcile'; versionId: string; documentId: string; contentSha256: string }
  | { kind: 'unindex'; versionId: string; documentId: string; knowledgeId: string }
  | { kind: 'forget'; versionId: string; documentId: string };

/**
 * Decides what one sync pass must do. Pure, so "running it twice changes nothing"
 * is a property we can assert directly rather than infer from a live run.
 *
 * - same version, same hash, already indexed  -> nothing
 * - known version, content changed            -> update in place, never a second record
 * - row exists but no knowledge ID            -> reconcile: a crash may have left an
 *                                                orphan in WeKnora, so look before creating
 * - version no longer retrievable             -> unindex (or forget, if never indexed)
 */
export function planExport(
  desired: readonly DesiredVersion[],
  existing: readonly IndexEntry[],
  options: { maxAttempts: number },
): ExportAction[] {
  const byVersion = new Map(existing.map((entry) => [entry.versionId, entry]));
  const wanted = new Set(desired.map((version) => version.versionId));
  const actions: ExportAction[] = [];

  for (const version of desired) {
    const entry = byVersion.get(version.versionId);
    if (!entry) {
      actions.push({ kind: 'create', ...version });
      continue;
    }
    if (entry.state === 'failed' && entry.attempts >= options.maxAttempts) continue;
    if (!entry.knowledgeId) {
      actions.push({ kind: 'reconcile', ...version });
      continue;
    }
    if (entry.state === 'indexed' && entry.contentSha256 === version.contentSha256) continue;
    actions.push({ kind: 'update', ...version, knowledgeId: entry.knowledgeId });
  }

  for (const entry of existing) {
    if (wanted.has(entry.versionId) || entry.state === 'revoked') continue;
    actions.push(
      entry.knowledgeId
        ? {
            kind: 'unindex',
            versionId: entry.versionId,
            documentId: entry.documentId,
            knowledgeId: entry.knowledgeId,
          }
        : { kind: 'forget', versionId: entry.versionId, documentId: entry.documentId },
    );
  }
  return actions;
}

/** A retrievable version, as IntraDocs sees it right now. The citation allowlist. */
export interface AllowedSource {
  knowledgeId: string;
  documentId: string;
  versionId: string;
  documentSlug: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
}

export interface RawHit {
  knowledgeId: string;
  chunkId: string;
  content: string;
  score: number;
  /** Optional: how the engine found the chunk. Absent means unknown. */
  matchType?: 'vector' | 'keyword' | 'context' | 'other';
  /**
   * Optional: what the engine says the chunk is. WeKnora indexes the summary it
   * generated at ingest as a `summary` chunk next to the document's own `text` chunks,
   * and hybrid search returns both. Absent is treated as `text` for engines that do not
   * distinguish; anything present and not `text` is model output and is never cited.
   */
  chunkType?: string;
  /** Cosine similarity from the vector-only pass, attached by gateByRelevance when known. */
  relevance?: number;
}

export interface GatedRetrieval {
  kept: RawHit[];
  /** Candidates that neither a similarity score nor an exact keyword match supported. */
  dropped: number;
  /** Best similarity among kept hits, or null when nothing carried a score. */
  topRelevance: number | null;
}

/**
 * Relevance gate.
 *
 * WeKnora's fused hybrid score is a rank constant (RRF, 1/61) whenever keyword and vector
 * results are merged, so it says nothing about how well a chunk matches. A vector-only
 * pass over the same scope returns the raw similarity instead. The two are joined here:
 * a hybrid candidate keeps its place if its similarity clears `minRelevance` or if it
 * was an exact keyword match; vector-only hits the fused ranking missed are added when
 * they clear the bar; neighbour chunks fetched for context never count as evidence.
 *
 * `minRelevance` 0 disables the gate and returns the hybrid list untouched. Nothing here
 * decides authorisation -- that happens in validateRetrieval, after this.
 */
export function gateByRelevance(
  hybrid: readonly RawHit[],
  vectorOnly: readonly RawHit[],
  minRelevance: number,
): GatedRetrieval {
  if (!(minRelevance > 0)) return { kept: [...hybrid], dropped: 0, topRelevance: null };
  const key = (h: RawHit) => `${h.knowledgeId}:${h.chunkId}`;
  const similarity = new Map<string, number>();
  for (const h of vectorOnly) if (h.matchType !== 'context') similarity.set(key(h), h.score);

  const scored: Array<{ hit: RawHit; relevance: number }> = [];
  const keywordOnly: RawHit[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const h of hybrid) {
    const k = key(h);
    if (seen.has(k)) continue;
    seen.add(k);
    const sim = similarity.get(k) ?? (h.matchType === 'vector' ? h.score : undefined);
    if (sim !== undefined && sim >= minRelevance) scored.push({ hit: h, relevance: sim });
    else if (h.matchType === 'keyword') keywordOnly.push(h);
    else dropped += 1;
  }
  for (const h of vectorOnly) {
    const k = key(h);
    if (seen.has(k) || h.matchType === 'context') continue;
    seen.add(k);
    if (h.score >= minRelevance) scored.push({ hit: h, relevance: h.score });
  }
  scored.sort((a, b) => b.relevance - a.relevance);
  return {
    kept: [...scored.map((s) => ({ ...s.hit, relevance: s.relevance })), ...keywordOnly],
    dropped,
    topRelevance: scored.length ? scored[0]!.relevance : null,
  };
}

export interface Citation {
  documentId: string;
  versionId: string;
  documentSlug: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  snippet: string;
  heading: string | null;
  anchor: string | null;
  href: string;
  score: number;
  /** Cosine similarity when the relevance gate measured one; null for keyword-only hits. */
  relevance: number | null;
}

export type RejectionReason =
  'unknown_source' | 'duplicate' | 'empty_content' | 'generated_content';

export interface ValidatedRetrieval {
  citations: Citation[];
  rejected: Array<{ knowledgeId: string; reason: RejectionReason }>;
}

/** Strips control characters and clamps length before any snippet reaches a client. */
export function sanitizeSnippet(text: string, maxChars: number): string {
  const cleaned = text
    // The exporter prepends a provenance header so a human inspecting the index can see
    // where a record came from. It is metadata about the document, not part of it, and it
    // was surfacing verbatim inside citation snippets shown to readers.
    .replace(/<!--\s*intradocs:[^>]*-->/g, ' ')
    .replace(/^\s*>\s*Sumber:\s*IntraDocs[^\n]*/gm, ' ')
    // A snippet is shown as a quote, so Markdown structure is noise: heading markers,
    // blockquote bars, emphasis, code fences and table rules go; the words stay.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/gm, ' ')
    .replace(/```[a-z]*/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\|/g, ' · ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(\s·\s*){2,}/g, ' · ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars).trimEnd()}…` : cleaned;
}

/**
 * Finds where a retrieved snippet actually sits in the authorised Markdown, and
 * returns the enclosing heading. Returns null when the snippet cannot be located:
 * a citation with no anchor is correct, an invented anchor is not.
 */
export function locateSnippet(
  markdown: string,
  snippet: string,
): { heading: string; anchor: string } | null {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const haystack = normalize(markdown);
  const needle = normalize(snippet).slice(0, 160);
  if (needle.length < 12) return null;
  const at = haystack.indexOf(needle);
  if (at < 0) return null;
  // Walk the original document, tracking the normalised offset, so the heading we
  // report is the one that really precedes the matched text.
  let consumed = 0;
  let heading: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const normalizedLine = normalize(line);
    const next = consumed + (normalizedLine ? normalizedLine.length + 1 : 0);
    if (consumed > at) break;
    const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (match && match[2]) heading = match[2].trim().replace(/\s*#+\s*$/, '');
    consumed = next;
  }
  return heading ? { heading, anchor: headingSlug(heading) } : null;
}

export interface ValidateOptions {
  maxSnippetChars: number;
  maxCitations: number;
  /** Authorised Markdown per version, used only to resolve honest locators. */
  markdownByVersion?: ReadonlyMap<string, string>;
}

/**
 * Turns WeKnora hits into citations, dropping everything IntraDocs cannot vouch for
 * at this instant. `allowed` must be recomputed from the database for this actor after
 * retrieval, so a grant revoked mid-request fails closed on the same response.
 */
export function validateRetrieval(
  hits: readonly RawHit[],
  allowed: ReadonlyMap<string, AllowedSource>,
  options: ValidateOptions,
): ValidatedRetrieval {
  const citations: Citation[] = [];
  const rejected: ValidatedRetrieval['rejected'] = [];
  const seenChunks = new Set<string>();
  for (const hit of hits) {
    const source = allowed.get(hit.knowledgeId);
    if (!source) {
      rejected.push({ knowledgeId: hit.knowledgeId, reason: 'unknown_source' });
      continue;
    }
    // Found in the index, about an authorised version, and still not citable: a
    // summary WeKnora wrote about the document is not the document. It would show up as
    // a quote with no anchor -- exactly what an invented citation looks like.
    if (hit.chunkType !== undefined && hit.chunkType !== 'text') {
      rejected.push({ knowledgeId: hit.knowledgeId, reason: 'generated_content' });
      continue;
    }
    const snippet = sanitizeSnippet(hit.content, options.maxSnippetChars);
    if (!snippet) {
      rejected.push({ knowledgeId: hit.knowledgeId, reason: 'empty_content' });
      continue;
    }
    const key = `${hit.knowledgeId}:${hit.chunkId}`;
    if (seenChunks.has(key)) {
      rejected.push({ knowledgeId: hit.knowledgeId, reason: 'duplicate' });
      continue;
    }
    seenChunks.add(key);
    if (citations.length >= options.maxCitations) continue;
    const markdown = options.markdownByVersion?.get(source.versionId);
    const located = markdown ? locateSnippet(markdown, hit.content) : null;
    citations.push({
      documentId: source.documentId,
      versionId: source.versionId,
      documentSlug: source.documentSlug,
      documentTitle: source.documentTitle,
      versionLabel: source.versionLabel,
      classification: source.classification,
      categoryName: source.categoryName,
      snippet,
      heading: located?.heading ?? null,
      anchor: located?.anchor ?? null,
      href: `/dokumen/${source.documentId}/${source.documentSlug}${located ? `#${located.anchor}` : ''}`,
      score: hit.score,
      relevance: hit.relevance ?? null,
    });
  }
  return { citations, rejected };
}

/** Validates a client question. Length, control characters and emptiness only. */
export function parseQuestion(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') throw new InputError('Pertanyaan harus berupa teks.');
  const trimmed = value.trim();
  if (!trimmed) throw new InputError('Pertanyaan tidak boleh kosong.');
  if (trimmed.length > maxChars) throw new InputError(`Pertanyaan maksimal ${maxChars} karakter.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed))
    throw new InputError('Pertanyaan memuat karakter kontrol.');
  return trimmed;
}

/**
 * Words a follow-up can be made of without naming anything: pronouns, connectives,
 * "more / in detail / why / how / again" and their Indonesian everyday spellings. A
 * question built only from these ("jelaskan lebih lengkap", "kenapa?", "apa saja
 * langkahnya?") carries no subject of its own, so retrieval on it alone finds nothing
 * and the assistant would abstain in the middle of a conversation about something it
 * had just answered. Anything else ("berapa harga saham?") names a subject and must
 * stand on its own -- inheriting the previous sources there would turn an honest
 * abstention into an answer built from the wrong documents.
 */
const CONTINUATION_WORDS = new Set(
  (
    'jelaskan jelasin terangkan uraikan rincikan rinci sebutkan elaborasi lebih lengkap detail ' +
    'detil jelas panjang singkat ringkas ringkasnya intinya lanjut lanjutkan lanjutannya terus ' +
    'teruskan kenapa mengapa bagaimana gimana caranya cara langkah langkahnya tahapan tahapannya ' +
    'contoh contohnya misalnya maksud maksudnya artinya berarti apa apakah kah saja aja yang itu ' +
    'ini tadi sebelumnya barusan tersebut nya dan lalu kemudian selanjutnya berikutnya lagi ulangi ' +
    'ulang sekali tolong mohon coba bisa boleh bisakah bolehkah ya iya tidak bukan kok dong sih ' +
    'deh nih ok oke baik jadi untuk dengan di ke dari pada secara tentang soal mengenai semua ' +
    'semuanya seluruhnya poin poinnya bagian bagiannya versi versinya sederhana simpel bahasa ' +
    'awam kalau jika kalo bila gitu begitu gini begini yg dgn tsb ' +
    'explain elaborate more detail details why how what that this it again continue please ' +
    'summarize summary shorter longer example examples steps'
  ).split(' '),
);

/**
 * True when a question is only a continuation of the previous turn -- see
 * CONTINUATION_WORDS. Bounded at eight words: a longer question is saying something.
 */
export function isContinuation(question: string): boolean {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/-?nya$/u, '').replace(/-/g, ''))
    .filter(Boolean);
  return words.length > 0 && words.length <= 8 && words.every((w) => CONTINUATION_WORDS.has(w));
}

/**
 * Messages that are about the assistant or the catalogue rather than about a document's
 * content. They never reach retrieval: the answer is composed from the catalogue the
 * person may read (RLS) or is a fixed sentence, so "apa ada dokumen lain yang menarik?"
 * gets a list instead of "tidak ada sumber". Content questions return null and go
 * through the gate as before; a question that names a document AND asks about its
 * content ("dokumen apa yang mengatur retensi?") is deliberately not matched.
 */
export type AssistantIntent = 'greeting' | 'thanks' | 'capabilities' | 'catalog';

export function classifyIntent(question: string): AssistantIntent | null {
  const q = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = q.replace(/\?/g, '').split(' ').filter(Boolean);
  if (words.length === 0) return null;
  if (
    words.length <= 12 &&
    /\b(bisa apa|apa yang (bisa|dapat) (kamu|anda|kau|lu)( lakukan| bantu)?|kamu siapa|siapa kamu|apa itu intradocs|cara (pakai|memakai|menggunakan) (asisten|kamu|ini)|bagaimana (cara )?bertanya|(fitur|kemampuan) (apa|kamu|anda|asisten)|kamu bisa|bantuan)\b/.test(
      q,
    )
  )
    return 'capabilities';
  if (
    words.length <= 4 &&
    /^(halo|hai|hi|hello|hey|selamat (pagi|siang|sore|malam)|pagi|siang|sore|malam|assalamualaikum|permisi|tes|test)\b/.test(
      q,
    )
  )
    return 'greeting';
  if (
    words.length <= 6 &&
    /^(terima kasih|makasih|thanks|thank you|thx|oke|ok|sip|mantap|baik|siap|noted)\b/.test(q)
  )
    return 'thanks';
  // The document must be the thing asked about -- "dokumen apa saja", "ada panduan
  // lain", "rekomendasi bacaan" -- not merely mentioned ("kebijakan backup ini berlaku
  // untuk dataset apa saja?" is a content question about one policy).
  const DOC = '(?:dokumen|doc|docs|panduan|sop|artikel|materi|topik|bacaan|referensi)\\w*';
  const catalog = [
    `^(?:apa|ada|adakah|apakah|punya|tolong|coba|bisa|mohon)?\\s*(?:ada\\s+)?${DOC}\\s+(?:lain|lainnya|apa saja|apa aja|menarik|tersedia|terbaru|populer|yang (?:lain|menarik|tersedia|ada|bisa|boleh|perlu|harus|terbaru|populer|paling))`,
    `\\b(?:rekomendasi|rekomendasikan|sarankan|saran|daftar|list|semua|seluruh)\\s+${DOC}`,
    `\\b${DOC}\\s+(?:apa saja|apa aja)\\s+yang\\s+(?:ada|tersedia|bisa|boleh)`,
    `\\b(?:apa|mana)\\s+(?:saja\\s+)?yang\\s+(?:bisa|boleh|dapat|perlu|harus)\\s+(?:saya|aku)\\s+baca`,
    `\\b(?:ada|berapa)\\s+(?:berapa\\s+)?${DOC}`,
  ];
  if (words.length <= 14 && catalog.some((p) => new RegExp(p, 'u').test(q))) return 'catalog';
  return null;
}

/**
 * A 3B model often opens with the decline sentence and then quotes the very passage
 * that answers ("Dokumen ... tidak membahas hal ini. Namun, dokumen tersebut menyebutkan
 * ... ping vpn.example.test"). When that continuation shares enough of the question's
 * own words, it IS the answer and is returned as such (leading "Namun," trimmed);
 * otherwise -- the continuation merely describes what the passages are about -- null,
 * and the caller keeps the honest "no direct answer" framing.
 */
export function salvageDecline(question: string, remainder: string): string | null {
  const content = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !CONTINUATION_WORDS.has(w)),
    );
  const asked = [...content(question)];
  if (asked.length === 0 || remainder.length < 40) return null;
  const said = content(remainder);
  const overlap = asked.filter((w) => said.has(w)).length;
  if (overlap < 2 && overlap < asked.length) return null;
  return remainder
    .replace(/^(?:namun|tetapi|akan tetapi|meskipun demikian|meski begitu)\s*,?\s*/iu, '')
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/**
 * PRD §3.4: when sources disagree, show the disagreement instead of letting the model
 * pick. Deterministic and narrow on purpose: a "quantity" is a number with a unit
 * (7 hari, 24 jam, 30 menit, 50 MiB, 2 tahap, 90%); two citations from DIFFERENT
 * documents that state different values for the same unit, each in a sentence that
 * shares a word with the question, are a conflict. Anything subtler (wording, policy
 * text without numbers) is not detected -- and is not claimed to be.
 */
export interface SourceConflict {
  unit: string;
  values: Array<{
    value: string;
    documentId: string;
    documentTitle: string;
    href: string;
    excerpt: string;
  }>;
}

const UNIT_ALIASES: Record<string, string> = {
  hari: 'hari',
  jam: 'jam',
  menit: 'menit',
  detik: 'detik',
  minggu: 'minggu',
  bulan: 'bulan',
  tahun: 'tahun',
  '%': '%',
  persen: '%',
  kali: 'kali',
  tahap: 'tahap',
  orang: 'orang',
  karakter: 'karakter',
  kb: 'KB',
  kib: 'KB',
  mb: 'MB',
  mib: 'MB',
  gb: 'GB',
  gib: 'GB',
};

export function detectConflicts(
  question: string,
  citations: ReadonlyArray<Pick<Citation, 'documentId' | 'documentTitle' | 'href' | 'snippet'>>,
): SourceConflict[] {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !CONTINUATION_WORDS.has(w));
  if (words.length === 0) return [];
  const byUnit = new Map<string, SourceConflict['values']>();
  const quantity =
    /(\d+(?:[.,]\d+)?)\s*(hari|jam|menit|detik|minggu|bulan|tahun|%|persen|kali|tahap|orang|karakter|kib|kb|mib|mb|gib|gb)\b/giu;
  for (const c of citations) {
    for (const sentence of c.snippet.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+|\s*\|\s*/)) {
      const lower = sentence.toLowerCase();
      if (!words.some((w) => lower.includes(w))) continue;
      for (const m of sentence.matchAll(quantity)) {
        const unit = UNIT_ALIASES[m[2]!.toLowerCase()];
        if (!unit) continue;
        const value = m[1]!.replace(',', '.');
        const list = byUnit.get(unit) ?? [];
        if (!list.some((v) => v.documentId === c.documentId && v.value === value))
          list.push({
            value,
            documentId: c.documentId,
            documentTitle: c.documentTitle,
            href: c.href,
            excerpt: sentence.trim().slice(0, 200),
          });
        byUnit.set(unit, list);
      }
    }
  }
  const out: SourceConflict[] = [];
  for (const [unit, values] of byUnit) {
    const documents = new Set(values.map((v) => v.documentId));
    const distinct = new Set(values.map((v) => v.value));
    if (documents.size < 2 || distinct.size < 2) continue;
    // Only a real disagreement: some document states a value another does not.
    const perDoc = new Map<string, Set<string>>();
    for (const v of values)
      perDoc.set(v.documentId, (perDoc.get(v.documentId) ?? new Set()).add(v.value));
    const sets = [...perDoc.values()];
    const agree = sets.every((a) => sets.every((b) => [...a].every((x) => b.has(x))));
    if (agree) continue;
    out.push({ unit, values });
  }
  return out;
}

/**
 * What a question is asked against. `all` is every active version the actor may read;
 * the other two NARROW that set -- a category the actor can see, or documents the actor
 * has opened. A scope never widens anything: the IDs are filtered through the same
 * row-level policies as the unscoped list, so an ID outside the actor's access simply
 * contributes nothing and the request abstains.
 */
export type RetrievalScope =
  | { type: 'all' }
  | { type: 'category'; categoryId: string }
  | { type: 'documents'; documentIds: string[] };

export const MAX_SCOPE_DOCUMENT_IDS = 20;

export function parseScope(value: unknown): RetrievalScope {
  if (value === undefined) return { type: 'all' };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Cakupan tidak valid.');
  const scope = value as Record<string, unknown>;
  const keys = Object.keys(scope).sort();
  if (scope.type === 'all' && keys.join() === 'type') return { type: 'all' };
  if (scope.type === 'category' && keys.join() === 'categoryId,type')
    return { type: 'category', categoryId: parseUuid(scope.categoryId) };
  if (scope.type === 'documents' && keys.join() === 'documentIds,type') {
    if (!Array.isArray(scope.documentIds) || scope.documentIds.length === 0)
      throw new InputError('Pilih minimal satu dokumen.');
    if (scope.documentIds.length > MAX_SCOPE_DOCUMENT_IDS)
      throw new InputError(`Maksimal ${MAX_SCOPE_DOCUMENT_IDS} dokumen per cakupan.`);
    return { type: 'documents', documentIds: [...new Set(scope.documentIds.map(parseUuid))] };
  }
  throw new InputError('Cakupan tidak valid.');
}

export interface ChatBody {
  question: string;
  scope: RetrievalScope;
  /** Continue an existing conversation; ownership is checked when the turn is stored. */
  conversationId: string | null;
}

/**
 * Body shape for the chat endpoint. Beyond the question, a client may only narrow the
 * scope and name a conversation of its own; any other field is rejected outright, so a
 * client cannot smuggle a system prompt, a knowledge base ID or a model name.
 */
export function parseChatBody(value: unknown, maxChars: number): ChatBody {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Payload tidak valid.');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['question', 'scope', 'conversationId']);
  for (const key of Object.keys(body))
    if (!allowed.has(key))
      throw new InputError(
        'Hanya field question, scope dan conversationId yang diizinkan. Prompt sistem, knowledge base dan model ditentukan server.',
      );
  return {
    question: parseQuestion(body.question, maxChars),
    scope: parseScope(body.scope),
    conversationId:
      body.conversationId === undefined || body.conversationId === null
        ? null
        : parseUuid(body.conversationId),
  };
}

export {
  ABSTAIN_MESSAGE,
  NO_DIRECT_ANSWER_MESSAGE,
  MODEL_DECLINE_SENTENCE,
  MODEL_DECLINE_PATTERN,
} from './rag-messages.ts';

/**
 * The generated answer as it should reach a reader. Two cases become the same reader-facing
 * sentence, next to the sources IntraDocs' gate did pass:
 *  - WeKnora's fixed fallback (the abstain sentence), emitted when its own pipeline --
 *    thresholds, or the reranker when one is on -- kept no chunk. Shown verbatim it would
 *    contradict the source list under it.
 *  - The model's own decline, which the pinned prompt asks for when the passages do not
 *    contain the answer. The small model paraphrases it and then often keeps writing
 *    about what the passages do say -- frequently the very sentence that answers
 *    ("...belum dianggap berhasil sebelum hasil restore dapat diverifikasi, namun tidak
 *    menyebutkan kapan tepatnya"). That continuation comes back as `remainder`, so the
 *    caller can show it as what the material does say rather than throw it away.
 * Any other text is passed through untouched.
 */
/**
 * Sentences a small model sometimes copies out of its own instructions and appends to an
 * otherwise good answer ("Riwayat percakapan hanya untuk memahami maksud pertanyaan, bukan
 * sumber fakta."). They are instructions, not facts from a document, so they never reach
 * the reader. Matched loosely (case, spacing) and removed as whole sentences.
 */
const PROMPT_ECHOES: RegExp[] = [
  /riwayat percakapan\s+(?:hanya\s+)?(?:dipakai\s+)?untuk memahami maksud pertanyaan[^.!?\n]*[.!?]?/giu,
  /(?:faktanya|fakta)\s+(?:tetap\s+)?hanya\s+dari materi(?: referensi)?[^.!?\n]*[.!?]?/giu,
  /dokumen yang tersedia tidak membahas hal lain[.!?]?/giu,
  /kata-kata penting \(negasi, angka, nama\) disalin persis[^.!?\n]*[.!?]?/giu,
  /\[runtime context[^\]]*\]/giu,
];
export function stripPromptEchoes(text: string): string {
  let out = text;
  for (const pattern of PROMPT_ECHOES) out = out.replace(pattern, '');
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)[ \t]*(?=\n|$)/g, '$1')
    .trim();
}

export function resolveGeneratedAnswer(text: string): {
  answer: string;
  fellBack: boolean;
  /** What the model wrote after its decline sentence, when anything; never a fixed fallback's. */
  remainder: string;
} {
  const trimmed = stripPromptEchoes(text);
  // Nothing but echoed instructions is no answer at all: same path as a decline.
  if (!trimmed || trimmed === ABSTAIN_MESSAGE)
    return { answer: NO_DIRECT_ANSWER_MESSAGE, fellBack: true, remainder: '' };
  if (MODEL_DECLINE_PATTERN.test(trimmed)) {
    // The decline sentence ends at its first period; the rest is the model's account of
    // the material. A remainder that only restates the decline is dropped.
    const end = trimmed.search(/[.!]\s|[.!]$/);
    const remainder = end >= 0 ? trimmed.slice(end + 1).trim() : '';
    return {
      answer: NO_DIRECT_ANSWER_MESSAGE,
      fellBack: true,
      remainder: remainder.length >= 40 && !MODEL_DECLINE_PATTERN.test(remainder) ? remainder : '',
    };
  }
  return { answer: trimmed, fellBack: false, remainder: '' };
}

/* ------------------------------------------------------------------ *
 * Export worker
 *
 * The worker role has EXECUTE on four fixed functions and no SELECT on business
 * tables, so eligibility is decided in SQL during reconciliation and travels here
 * as a claimed operation. This module never re-decides whether a version may be
 * indexed; it only carries out the operation the lease describes.
 * ------------------------------------------------------------------ */

export interface RagExportClaim {
  jobId: string;
  leaseToken: string;
  versionId: string;
  documentId: string;
  markdownKey: string;
  markdownHash: string;
  operation: 'upsert' | 'remove';
  knowledgeId: string | null;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
}

export interface RagExportRepository {
  reconcile(): Promise<number>;
  /** Version IDs that legitimately hold an index record right now. */
  knownVersions(): Promise<Set<string>>;
  claim(): Promise<RagExportClaim | null>;
  complete(
    claim: RagExportClaim,
    result: { knowledgeId: string | null; sourceHash: string; chunkCount: number },
  ): Promise<void>;
  fail(claim: RagExportClaim): Promise<void>;
}

/** The WeKnora side, narrowed to what the exporter needs so tests can substitute it. */
export interface RagIndexTarget {
  create(input: { title: string; content: string }): Promise<string>;
  update(knowledgeId: string, input: { title: string; content: string }): Promise<void>;
  remove(knowledgeId: string): Promise<void>;
  findByTitle(title: string): Promise<string | null>;
  /** Everything currently stored, for the orphan sweep. */
  list(): Promise<Array<{ id: string; title: string }>>;
}

/**
 * Deletes WeKnora records whose IntraDocs version no longer has an index row.
 *
 * These appear when a version is deleted outright: the foreign-key cascade drops the
 * mapping before the exporter can issue the delete, so nothing is left to queue a
 * removal from. Retrieval is unaffected either way -- an orphan has no mapping row and
 * therefore can never be resolved into a citation -- so this is storage hygiene.
 *
 * Only records carrying our own title marker are considered. Anything else in the
 * knowledge base belongs to someone else and is left untouched.
 */
export async function sweepRagOrphans(deps: {
  repository: Pick<RagExportRepository, 'knownVersions'>;
  index: Pick<RagIndexTarget, 'list' | 'remove'>;
  limit?: number;
}): Promise<{ scanned: number; removed: number }> {
  const known = await deps.repository.knownVersions();
  const records = await deps.index.list();
  let removed = 0;
  const limit = deps.limit ?? 100;
  for (const record of records) {
    const versionId = versionIdFromIndexTitle(record.title);
    // No marker means the record was not written by this exporter.
    if (!versionId || known.has(versionId)) continue;
    if (removed >= limit) break;
    await deps.index.remove(record.id);
    removed += 1;
  }
  return { scanned: records.length, removed };
}

export class RagExportError extends Error {}

/**
 * Runs one claimed export. Returns false when the queue is empty.
 *
 * Idempotency comes from three places rather than from hoping the job runs once:
 * the SQL lease admits a single worker, the knowledge title carries the version ID so
 * a crash between "created in WeKnora" and "recorded in IntraDocs" is recoverable by
 * lookup instead of by creating a second record, and complete() stores the content
 * hash so an unchanged version is never re-sent.
 */
export async function processRagExport(deps: {
  repository: RagExportRepository;
  index: RagIndexTarget;
  read: (key: string, hash: string) => Promise<Uint8Array>;
  digest: (bytes: Uint8Array) => string;
}): Promise<boolean> {
  const claim = await deps.repository.claim();
  if (!claim) return false;
  try {
    if (claim.operation === 'remove') {
      // A version that was never indexed has nothing to delete; recording the removal
      // still clears the queue so a revoke cannot loop forever.
      if (claim.knowledgeId) await deps.index.remove(claim.knowledgeId);
      await deps.repository.complete(claim, { knowledgeId: null, sourceHash: '', chunkCount: 0 });
      return true;
    }
    const bytes = await deps.read(claim.markdownKey, claim.markdownHash);
    const actual = deps.digest(bytes);
    if (actual !== claim.markdownHash)
      throw new RagExportError('Checksum dokumen tidak cocok; ekspor dibatalkan.');
    const payload = buildExportPayload({
      documentId: claim.documentId,
      versionId: claim.versionId,
      documentTitle: claim.documentTitle,
      versionLabel: claim.versionLabel,
      classification: claim.classification,
      categoryName: claim.categoryName,
      markdown: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    });
    let knowledgeId = claim.knowledgeId;
    if (!knowledgeId) knowledgeId = await deps.index.findByTitle(payload.title);
    if (knowledgeId) await deps.index.update(knowledgeId, payload);
    else knowledgeId = await deps.index.create(payload);
    await deps.repository.complete(claim, {
      knowledgeId,
      sourceHash: claim.markdownHash,
      chunkCount: 1,
    });
  } catch {
    // The reason stays in the worker log; the queue records only a generic code so a
    // provider message can never travel into the database or a user-facing surface.
    await deps.repository.fail(claim);
  }
  return true;
}
