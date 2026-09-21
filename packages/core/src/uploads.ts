import { createHash } from 'node:crypto';
import { CLASSIFICATIONS, type Classification } from './index.ts';
import { InputError, parseUuid, headingSlug } from './validation.ts';
export const UPLOAD_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  bodyBytes: 100 * 1024 * 1024 + 65536,
  totalBytes: 100 * 1024 * 1024,
  attachments: 4,
  binaryBytes: 50 * 1024 * 1024,
  lines: 20000,
  lineCharacters: 20000,
  perHour: 20,
  leaseSeconds: 300,
  maxAttempts: 3,
  ownedDrafts: 200,
});
export const UPLOAD_PIPELINE = 'text-v1';
export type TextFormat = 'MD' | 'TXT';
export type SourceFormat = TextFormat | 'PDF' | 'DOCX' | 'XLSX' | 'HTML' | 'PPTX';
/** Formats the local converter handles; PPTX needs WeKnora's parser (weknora-parse.ts). */
export const LOCAL_FORMATS: readonly SourceFormat[] = ['MD', 'TXT', 'PDF', 'DOCX', 'XLSX', 'HTML'];
export class UploadError extends InputError {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(code: string, message: string, status = 400, retryAfter?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export type DraftMetadata = {
  title: string;
  summary: string;
  categoryId: string;
  classification: Classification;
  labels: string[];
  synthetic: true;
  documentId?: string;
  baseVersionId?: string;
};
const control = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
function field(
  value: unknown,
  label: string,
  max: number,
  required = false,
  multiline = false,
): string {
  if (typeof value !== 'string') throw new UploadError('invalid_metadata', `${label} tidak valid.`);
  const text = (multiline ? value.replace(/\r\n?/g, '\n') : value).normalize('NFC').trim();
  if (
    text.length > max ||
    control.test(multiline ? text.replace(/[\n\t]/g, '') : text) ||
    (required && text.length < 3)
  )
    throw new UploadError(
      'invalid_metadata',
      `${label} harus ${required ? '3–' : 'maksimal '}${max} karakter tanpa control character.`,
    );
  return text;
}
export function parseDraftMetadata(value: unknown): DraftMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UploadError('invalid_metadata', 'Metadata tidak valid.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'title',
          'summary',
          'categoryId',
          'classification',
          'labels',
          'synthetic',
          'documentId',
          'baseVersionId',
        ].includes(k),
    )
  )
    throw new UploadError('invalid_metadata', 'Ada field metadata yang tidak diizinkan.');
  if (!(CLASSIFICATIONS as readonly unknown[]).includes(v.classification) || v.synthetic !== true)
    throw new UploadError(
      'invalid_metadata',
      'Hanya dokumen sintetis berklasifikasi Internal untuk alur ini.',
    );
  if (!Array.isArray(v.labels) || v.labels.length > 8)
    throw new UploadError('invalid_metadata', 'Maksimal 8 label.');
  if ((v.documentId === undefined) !== (v.baseVersionId === undefined))
    throw new UploadError('invalid_metadata', 'Revisi memerlukan ID dokumen dan versi dasar.');
  const labels = [...new Set(v.labels.map((x) => field(x, 'Label', 32, true)))].sort();
  return {
    title: field(v.title, 'Judul', 180, true),
    summary: field(v.summary, 'Ringkasan', 1000, false, true),
    categoryId: parseUuid(v.categoryId),
    classification: v.classification as Classification,
    labels,
    synthetic: true,
    ...(v.documentId === undefined
      ? {}
      : { documentId: parseUuid(v.documentId), baseVersionId: parseUuid(v.baseVersionId) }),
  };
}
export type UploadFile = {
  name: string;
  mime: string;
  bytes: Uint8Array;
  format: SourceFormat;
  sha256: string;
};
export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function validateTextFile(name: string, mime: string, bytes: Uint8Array): UploadFile {
  const filename = name.normalize('NFC');
  if (
    !filename ||
    filename.length > 180 ||
    control.test(filename) ||
    /[/\\:*?"<>|]/u.test(filename) ||
    /^[. ]|[. ]$/u.test(filename)
  )
    throw new UploadError(
      'invalid_filename',
      'Nama file tidak valid; gunakan nama berkas biasa tanpa path.',
    );
  const ext = filename.split('.').at(-1)?.toLowerCase();
  if (ext !== 'md' && ext !== 'txt')
    throw new UploadError('unsupported_format', 'Konverter teks hanya menerima .md dan .txt.', 415);
  const contentType = mime.toLowerCase().split(';')[0]!.trim();
  if (
    !['', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/octet-stream'].includes(
      contentType,
    )
  )
    throw new UploadError(
      'unsupported_format',
      'Tipe file tidak sesuai dengan format teks yang didukung.',
      415,
    );
  if (bytes.byteLength === 0)
    throw new UploadError('empty_file', 'Berkas kosong tidak dapat diunggah.');
  if (bytes.byteLength > UPLOAD_LIMITS.fileBytes)
    throw new UploadError(
      'file_too_large',
      'Maksimal 50 MiB per berkas; hasil Markdown maksimal 2 MiB.',
      413,
    );
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const signatures = [
    Buffer.from('%PDF-'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from([0x4d, 0x5a]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  ];
  if (signatures.some((s) => prefix.subarray(0, s.length).equals(s)))
    throw new UploadError(
      'unsupported_format',
      'Konten biner tidak dapat disamarkan sebagai Markdown/TXT.',
      415,
    );
  return {
    name: filename,
    mime: contentType,
    bytes,
    format: ext === 'md' ? 'MD' : 'TXT',
    sha256: digest(bytes),
  };
}
export function uploadFingerprint(
  file: Pick<UploadFile, 'name' | 'format' | 'sha256'>,
  metadata: DraftMetadata,
  attachments: Pick<UploadFile, 'name' | 'format' | 'sha256'>[] = [],
): string {
  return digest(
    JSON.stringify({
      pipeline: UPLOAD_PIPELINE,
      name: file.name,
      format: file.format,
      sourceHash: file.sha256,
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              name: a.name,
              format: a.format,
              sourceHash: a.sha256,
            })),
          }
        : {}),
      metadata,
    }),
  );
}
export type LineMapping = {
  sourceStart: number;
  sourceEnd: number;
  markdownStart: number;
  markdownEnd: number;
};
export type ConvertedText = {
  markdown: Uint8Array;
  sha256: string;
  lineCount: number;
  mapping: LineMapping;
  normalizations: string[];
  sourceMappings?: { kind: string; locator: string; markdownStart: number; markdownEnd: number }[];
  warnings?: string[];
  pipeline?: string;
};
export function convertText(file: UploadFile): ConvertedText {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new UploadError(
      'invalid_encoding',
      'Berkas harus berupa UTF-8; encoding lain belum didukung.',
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new UploadError(
      'invalid_text',
      'Konten memiliki karakter kontrol/biner yang tidak didukung.',
    );
  if (!text.trim()) throw new UploadError('empty_file', 'Berkas tidak memiliki isi teks.');
  const normalizations: string[] = [];
  if (file.bytes[0] === 0xef && file.bytes[1] === 0xbb && file.bytes[2] === 0xbf)
    normalizations.push('utf8-bom-removed');
  if (text.includes('\r')) normalizations.push('line-endings-to-lf');
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (
    lines.length > UPLOAD_LIMITS.lines ||
    lines.some((l) => l.length > UPLOAD_LIMITS.lineCharacters)
  )
    throw new UploadError(
      'text_complexity',
      'Teks terlalu panjang per baris atau memiliki terlalu banyak baris untuk konversi lokal.',
    );
  let markdown: string, offset: number;
  if (file.format === 'MD') {
    markdown = text;
    offset = 0;
  } else {
    let longest = 2;
    for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    const fence = '`'.repeat(longest + 1);
    markdown = `${fence}text\n${text}\n${fence}\n`;
    offset = 1;
    normalizations.push('txt-wrapped-as-literal-code-block');
  }
  const bytes = Buffer.from(markdown, 'utf8');
  if (bytes.length > 2 * 1024 * 1024)
    throw new UploadError('file_too_large', 'Hasil Markdown melebihi batas artefak.', 413);
  return {
    markdown: bytes,
    sha256: digest(bytes),
    lineCount: lines.length,
    mapping: {
      sourceStart: 1,
      sourceEnd: lines.length,
      markdownStart: 1 + offset,
      markdownEnd: lines.length + offset,
    },
    normalizations,
  };
}
export function draftSlug(title: string): string {
  return headingSlug(title).slice(0, 100).replace(/-+$/, '') || 'dokumen';
}

export function validateDocumentFile(
  name: string,
  mime: string,
  bytes: Uint8Array,
  accepted: readonly SourceFormat[] = LOCAL_FORMATS,
): UploadFile {
  if (/\.(md|txt)$/i.test(name)) return validateTextFile(name, mime, bytes);
  if (
    !name ||
    name.length > 180 ||
    control.test(name) ||
    /[/\\:*?"<>|]/u.test(name) ||
    /^[. ]|[. ]$/u.test(name)
  )
    throw new UploadError('invalid_filename', 'Nama berkas tidak valid.');
  const format = name.split('.').at(-1)?.toUpperCase();
  const binary: readonly string[] = accepted.filter((f) => f !== 'MD' && f !== 'TXT');
  if (!binary.includes(format ?? ''))
    throw new UploadError(
      'unsupported_format',
      `Gunakan MD, TXT, PDF bertesks, ${binary.filter((f) => f !== 'PDF').join(', ')}.`,
      415,
    );
  if (!bytes.length) throw new UploadError('empty_file', 'Berkas kosong.');
  if (bytes.length > UPLOAD_LIMITS.binaryBytes)
    throw new UploadError('file_too_large', 'Berkas maksimal 50 MiB.', 413);
  const contentType = mime.toLowerCase().split(';')[0]!.trim();
  const types: Record<string, string> = {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    HTML: 'text/html',
  };
  // HTML has no magic bytes: it must start with '<' after an optional BOM and whitespace.
  const head = Buffer.from(bytes.subarray(0, 64));
  const looksLike =
    format === 'HTML'
      ? /^\s*<|^\xef\xbb\xbf\s*</.test(head.toString('latin1'))
      : head
          .subarray(0, 5)
          .equals(
            format === 'PDF'
              ? Buffer.from('%PDF-')
              : Buffer.from([0x50, 0x4b, 0x03, 0x04, head[4] ?? 0]),
          );
  if (!['', 'application/octet-stream', types[format!]!].includes(contentType) || !looksLike)
    throw new UploadError(
      'unsupported_format',
      'Ekstensi, MIME, dan magic bytes tidak cocok.',
      415,
    );
  return {
    name: name.normalize('NFC'),
    mime: contentType,
    bytes,
    format: format as SourceFormat,
    sha256: digest(bytes),
  };
}
