// Pure RAG policy: export shaping, idempotency planning, citation validation and
// locator resolution. No I/O, no network, no database — so every rule below is
// unit-testable offline and cannot be softened by a live service being agreeable.
import { createHash } from 'node:crypto';
import { headingSlug, InputError } from './validation.ts';

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
    kept: [...scored.map((s) => s.hit), ...keywordOnly],
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
}

export type RejectionReason = 'unknown_source' | 'duplicate' | 'empty_content';

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
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
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
 * Body shape for the chat endpoint. Any extra field is rejected outright, so a client
 * cannot smuggle a system prompt, a knowledge base ID, a model name or a scope.
 */
export function parseChatBody(value: unknown, maxChars: number): { question: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Payload tidak valid.');
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'question')
    throw new InputError(
      'Hanya field question yang diizinkan. Prompt sistem, knowledge base dan model ditentukan server.',
    );
  return { question: parseQuestion(body.question, maxChars) };
}

export { ABSTAIN_MESSAGE } from './rag-messages.ts';

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
