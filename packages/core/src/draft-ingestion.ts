import type { Actor } from './index.ts';
import { hasCapability } from './index.ts';
import type { BlobStore, StoredFile } from './ports.ts';
import type { MalwareScanner, ScanEvidence } from './clamav.ts';
import { parseUuid } from './validation.ts';
import {
  UPLOAD_PIPELINE,
  UPLOAD_LIMITS,
  UploadError,
  parseDraftMetadata,
  validateDocumentFile,
  uploadFingerprint,
  convertText,
  digest,
  type DraftMetadata,
  type UploadFile,
  type ConvertedText,
} from './uploads.ts';
export type DraftResult = { documentId: string; versionId: string; slug: string; reused: boolean };
export type UploadClaim = {
  ownerId: string;
  requestId: string;
  leaseToken: string;
  documentId: string;
  versionId: string;
  payloadHash: string;
};
export type DraftAttachment = {
  ordinal: number;
  name: string;
  format: string;
  sha256: string;
  original: StoredFile;
  evidence: ScanEvidence;
  mapping: unknown;
};
export type DraftArtifacts = {
  original: StoredFile;
  markdown: StoredFile;
  provenance: StoredFile;
  attachments?: DraftAttachment[];
};
export interface DraftRepository {
  reserve(
    actor: Actor,
    requestId: string,
    payloadHash: string,
    metadata: DraftMetadata,
  ): Promise<{ kind: 'complete'; result: DraftResult } | { kind: 'claimed'; claim: UploadClaim }>;
  complete(
    actor: Actor,
    claim: UploadClaim,
    metadata: DraftMetadata,
    file: UploadFile,
    converted: ConvertedText,
    artifacts: DraftArtifacts,
    evidence: ScanEvidence,
  ): Promise<DraftResult>;
  fail(actor: Actor, claim: UploadClaim, code: string): Promise<void>;
}
export type IngestDependencies = {
  repository: DraftRepository;
  scanner: MalwareScanner;
  storage: BlobStore;
  converter?: import('./converter.ts').DocumentConverter;
};
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new UploadError('cancelled', 'Unggahan dibatalkan.');
}
function verifyStored(
  stored: StoredFile,
  key: string,
  bytes: Uint8Array,
  expectedHash: string,
): void {
  if (
    stored.key !== key ||
    stored.size !== bytes.length ||
    stored.sha256 !== expectedHash ||
    stored.sha256 !== digest(bytes)
  )
    throw new UploadError(
      'storage_integrity',
      'Penyimpanan tidak lolos pemeriksaan integritas.',
      503,
    );
}
export async function ingestDraft(
  input: {
    actor: Actor;
    requestId: string;
    metadata: unknown;
    name: string;
    mime: string;
    bytes: Uint8Array;
    attachments?: { name: string; mime: string; bytes: Uint8Array }[];
    signal?: AbortSignal;
  },
  deps: IngestDependencies,
): Promise<DraftResult> {
  if (!hasCapability(input.actor, 'documents.upload'))
    throw new UploadError('forbidden', 'Akun tidak diizinkan mengunggah.', 403);
  const requestId = parseUuid(input.requestId),
    metadata = parseDraftMetadata(input.metadata);
  const file = validateDocumentFile(input.name, input.mime, input.bytes);
  const attachments = (input.attachments ?? []).map((a) =>
    validateDocumentFile(a.name, a.mime, a.bytes),
  );
  if (
    attachments.length > UPLOAD_LIMITS.attachments ||
    [file, ...attachments].reduce((n, f) => n + f.bytes.length, 0) > UPLOAD_LIMITS.totalBytes
  )
    throw new UploadError('file_too_large', 'Maksimal empat lampiran dan total 100 MiB.', 413);
  const payloadHash = uploadFingerprint(file, metadata, attachments);
  cancelled(input.signal);
  const reservation = await deps.repository.reserve(input.actor, requestId, payloadHash, metadata);
  if (reservation.kind === 'complete') return { ...reservation.result, reused: true };
  const claim = reservation.claim;
  try {
    cancelled(input.signal);
    const evidence = await deps.scanner.scan(file.bytes, input.signal);
    if (
      evidence.verdict !== 'clean' ||
      evidence.sha256 !== file.sha256 ||
      evidence.engine !== 'clamav'
    )
      throw new UploadError('scanner_integrity', 'Hasil scan tidak sesuai dengan berkas.', 503);
    const convert = async (f: UploadFile) =>
      deps.converter
        ? deps.converter.convert(f, input.signal)
        : f.format === 'MD' || f.format === 'TXT'
          ? convertText(f)
          : Promise.reject(
              new UploadError(
                'converter_unavailable',
                'Converter diperlukan untuk format ini.',
                503,
              ),
            );
    let converted = await convert(file);
    const parts: {
      file: UploadFile;
      converted: ConvertedText;
      evidence: ScanEvidence;
      lineOffset: number;
    }[] = [];
    for (const attachment of attachments) {
      cancelled(input.signal);
      const scan = await deps.scanner.scan(attachment.bytes, input.signal);
      if (scan.verdict !== 'clean' || scan.engine !== 'clamav' || scan.sha256 !== attachment.sha256)
        throw new UploadError('scanner_integrity', 'Scan lampiran tidak cocok.', 503);
      const result = await convert(attachment);
      parts.push({ file: attachment, converted: result, evidence: scan, lineOffset: 0 });
    }
    if (parts.length) {
      let text = Buffer.from(converted.markdown).toString('utf8');
      for (const [i, part] of parts.entries()) {
        // Filename remains literal, never an uploaded Markdown directive.
        const name = part.file.name.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&');
        text += `\n\n## Lampiran ${i + 1}: ${name}\n\n`;
        part.lineOffset = text.split('\n').length - 1;
        text += Buffer.from(part.converted.markdown).toString('utf8');
      }
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new UploadError(
          'conversion_failed',
          'Gabungan Markdown utama dan lampiran maksimal 2 MiB.',
          422,
        );
      converted = {
        ...converted,
        markdown: Buffer.from(text),
        sha256: digest(text),
        pipeline: 'canonical-v2',
      };
    }
    cancelled(input.signal);
    if (converted.markdown.length > 2097152)
      throw new UploadError('conversion_failed', 'Canonical maksimal 2 MiB.', 422);
    const prefix = `documents/${claim.documentId}/versions/${claim.versionId}`;
    const originalKey = `${prefix}/original.${file.format.toLowerCase()}`,
      markdownKey = `${prefix}/content.md`,
      provenanceKey = `${prefix}/provenance.json`;
    const proof = Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          pipeline: converted.pipeline ?? UPLOAD_PIPELINE,
          documentId: claim.documentId,
          versionId: claim.versionId,
          source: {
            name: file.name,
            format: file.format,
            sha256: file.sha256,
            byteSize: file.bytes.length,
            ...(file.format === 'MD' || file.format === 'TXT' ? { encoding: 'utf-8' } : {}),
          },
          canonical: { sha256: converted.sha256, byteSize: converted.markdown.length },
          mapping: converted.sourceMappings ?? converted.mapping,
          warnings: converted.warnings ?? [],
          normalizations: converted.normalizations,
          attachments: parts.map((a, i) => ({
            ordinal: i + 1,
            name: a.file.name,
            format: a.file.format,
            sourceHash: a.file.sha256,
            byteSize: a.file.bytes.length,
            canonicalHash: a.converted.sha256,
            lineOffset: a.lineOffset,
            mapping: a.converted.sourceMappings ?? a.converted.mapping,
            warnings: a.converted.warnings ?? [],
            scan: a.evidence,
          })),
          metadata,
          scan: evidence,
        },
        null,
        2,
      ) + '\n',
    );
    const proofHash = digest(proof);
    const storedAttachments: DraftAttachment[] = [];
    // All files have already passed scan/conversion before the first storage write.
    for (const [i, a] of parts.entries()) {
      const key = `${prefix}/attachment-${i + 1}.${a.file.format.toLowerCase()}`;
      const stored = await deps.storage.putImmutable(key, a.file.bytes);
      verifyStored(stored, key, a.file.bytes, a.file.sha256);
      cancelled(input.signal);
      storedAttachments.push({
        ordinal: i + 1,
        name: a.file.name,
        format: a.file.format,
        sha256: a.file.sha256,
        original: stored,
        evidence: a.evidence,
        mapping: {
          lineOffset: a.lineOffset,
          source: a.converted.sourceMappings ?? a.converted.mapping,
        },
      });
    }
    const original = await deps.storage.putImmutable(originalKey, file.bytes);
    verifyStored(original, originalKey, file.bytes, file.sha256);
    cancelled(input.signal);
    const markdown = await deps.storage.putImmutable(markdownKey, converted.markdown);
    verifyStored(markdown, markdownKey, converted.markdown, converted.sha256);
    cancelled(input.signal);
    const provenance = await deps.storage.putImmutable(provenanceKey, proof);
    verifyStored(provenance, provenanceKey, proof, proofHash);
    cancelled(input.signal);
    return await deps.repository.complete(
      input.actor,
      claim,
      metadata,
      file,
      converted,
      { original, markdown, provenance, attachments: storedAttachments },
      evidence,
    );
  } catch (error) {
    // Never undo an ambiguous commit. Only the still-processing lease can be marked failed.
    await deps.repository
      .fail(input.actor, claim, error instanceof UploadError ? error.code : 'processing_failed')
      .catch(() => undefined);
    throw error;
  }
}
