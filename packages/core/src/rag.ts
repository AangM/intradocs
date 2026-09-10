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

/** The one answer we are allowed to give when nothing survived validation. */
export const ABSTAIN_MESSAGE =
  'Tidak ada sumber resmi yang dapat Anda akses untuk menjawab pertanyaan ini. IntraDocs tidak menjawab tanpa bukti dokumen.';
