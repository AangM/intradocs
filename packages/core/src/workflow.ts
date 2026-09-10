import { InputError, parseUuid } from './validation.ts';
import { digest } from './uploads.ts';
export const WORKFLOW_REVISION = 'lexical-v1';
export const DECISIONS = ['approve', 'changes_requested', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];
export type ReviewState = 'draft' | 'in_review' | 'changes_requested' | 'rejected' | 'approved';
export class WorkflowError extends InputError {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}
export function objectInput(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Payload tidak valid.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new InputError('Field tidak diizinkan.');
  return v;
}
export function boundedText(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== 'string') throw new InputError(`${label} tidak valid.`);
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (
    text.length < min ||
    text.length > max ||
    /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
  )
    throw new InputError(`${label}: ${min}–${max} karakter tanpa karakter kontrol.`);
  return text;
}
function date(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new InputError('Tanggal harus YYYY-MM-DD yang valid.');
  return value;
}
export function parseSubmit(value: unknown) {
  const v = objectInput(value, ['versionId', 'reviewers', 'reviewAt', 'expiresAt']);
  if (
    !Array.isArray(v.reviewers) ||
    v.reviewers.length < 1 ||
    v.reviewers.length > 2 ||
    v.reviewers.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(x)) ||
    new Set(v.reviewers).size !== v.reviewers.length
  )
    throw new InputError('Pilih satu atau dua reviewer berbeda.');
  const reviewAt = date(v.reviewAt),
    expiresAt = date(v.expiresAt);
  if (reviewAt && expiresAt && reviewAt > expiresAt)
    throw new InputError('Tanggal review sesudah kedaluwarsa.');
  return {
    versionId: parseUuid(v.versionId),
    reviewers: v.reviewers as string[],
    reviewAt,
    expiresAt,
  };
}
export function parseDecision(value: unknown) {
  const v = objectInput(value, ['versionId', 'decision', 'reason']);
  if (!(DECISIONS as readonly unknown[]).includes(v.decision))
    throw new InputError('Keputusan tidak valid.');
  return {
    versionId: parseUuid(v.versionId),
    decision: v.decision as Decision,
    reason: boundedText(v.reason ?? '', v.decision === 'approve' ? 0 : 10, 2000, 'Catatan'),
  };
}
export function parseFeedback(value: unknown) {
  const v = objectInput(value, ['versionId', 'helpful', 'comment']);
  if (typeof v.helpful !== 'boolean') throw new InputError('Pilihan membantu harus boolean.');
  return {
    versionId: parseUuid(v.versionId),
    helpful: v.helpful,
    comment: boundedText(v.comment ?? '', 0, 2000, 'Usulan perbaikan'),
  };
}
export type Finding = {
  rule: string;
  severity: 'block' | 'review';
  line: number;
  fingerprint: string;
};
export function findSensitiveContent(markdown: string): Finding[] {
  const rules = [
    {
      id: 'private-key',
      severity: 'block' as const,
      re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    },
    {
      id: 'credential-assignment',
      severity: 'review' as const,
      re: /\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[^\s"'`]{8,}/i,
    },
    { id: 'bearer-token', severity: 'review' as const, re: /\bBearer\s+[A-Za-z0-9._~-]{20,}/ },
    { id: 'personal-id', severity: 'review' as const, re: /\b(?:NIK|KTP)\s*[:=]?\s*\d{16}\b/i },
  ];
  const result: Finding[] = [];
  for (const [i, line] of markdown.split('\n').entries())
    for (const rule of rules) {
      const match = line.match(rule.re);
      if (match)
        result.push({
          rule: rule.id,
          severity: rule.severity,
          line: i + 1,
          fingerprint: digest(`${rule.id}:${i + 1}:${match[0]}`),
        });
      if (result.length === 100) return result;
    }
  return result;
}
export function requiredApprovalSteps(v: {
  classification: string;
  labels: readonly string[];
  categorySteps: number;
}): 1 | 2 {
  return v.categorySteps === 2 ||
    ['restricted', 'confidential'].includes(v.classification) ||
    v.labels.some((l) => l.toLowerCase() === 'kritikal')
    ? 2
    : 1;
}
export function reviewTransition(v: {
  state: ReviewState;
  author: string;
  actor: string;
  assignee: string;
  stage: number;
  stages: number;
  previousApproved: boolean;
  decision: Decision;
  unresolved: number;
}) {
  if (v.state !== 'in_review') throw new WorkflowError('Pengajuan sudah berubah.');
  if (v.actor === v.author || v.actor !== v.assignee)
    throw new WorkflowError('Pengajuan tidak tersedia.', 404);
  if (!v.previousApproved) throw new WorkflowError('Tahap sebelumnya belum selesai.');
  if (v.decision === 'approve' && v.unresolved > 0)
    throw new WorkflowError('Temuan belum diselesaikan.');
  if (v.decision === 'changes_requested')
    return { state: 'changes_requested' as const, enqueue: false };
  if (v.decision === 'reject') return { state: 'rejected' as const, enqueue: false };
  return v.stage === v.stages
    ? { state: 'approved' as const, enqueue: true }
    : { state: 'in_review' as const, enqueue: false };
}
export type LexicalChunk = { ordinal: number; text: string; lineStart: number; lineEnd: number };
export function lexicalChunks(markdown: string, maxCharacters = 4000): LexicalChunk[] {
  if (!markdown.trim() || Buffer.byteLength(markdown) > 2097152)
    throw new WorkflowError('Markdown kosong atau terlalu besar.');
  if (!Number.isInteger(maxCharacters) || maxCharacters < 64 || maxCharacters > 16000)
    throw new InputError('Batas chunk tidak valid.');
  const out: LexicalChunk[] = [];
  let start = 0,
    line = 1;
  while (start < markdown.length) {
    let end = Math.min(start + maxCharacters, markdown.length);
    if (end < markdown.length && /[\uD800-\uDBFF]/.test(markdown[end - 1]!)) end--;
    const newline = markdown.lastIndexOf('\n', end - 1);
    if (end < markdown.length && newline > start + maxCharacters / 2) end = newline + 1;
    const text = markdown.slice(start, end),
      breaks = text.split('\n').length - 1;
    out.push({ ordinal: out.length, text, lineStart: line, lineEnd: line + breaks });
    start = end;
    line += breaks;
  }
  if (out.length > 1000) throw new WorkflowError('Indeks terlalu besar.');
  return out;
}
export interface PublicationClaim {
  jobId: string;
  leaseToken: string;
  versionId: string;
  documentId: string;
  markdownKey: string;
  markdownHash: string;
}
export interface PublicationRepository {
  claim(): Promise<PublicationClaim | null>;
  publish(c: PublicationClaim, chunks: LexicalChunk[]): Promise<void>;
  fail(c: PublicationClaim, code: string): Promise<void>;
}
export async function processPublication(deps: {
  repository: PublicationRepository;
  read: (key: string, hash: string) => Promise<Uint8Array>;
}): Promise<boolean> {
  const c = await deps.repository.claim();
  if (!c) return false;
  try {
    const bytes = await deps.read(c.markdownKey, c.markdownHash);
    if (digest(bytes) !== c.markdownHash) throw new WorkflowError('Checksum mismatch');
    await deps.repository.publish(
      c,
      lexicalChunks(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    await deps.repository.fail(c, 'index_failed');
  }
  return true;
}
