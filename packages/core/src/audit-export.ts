/**
 * The audit trail as a file: the same rows the audit page shows, under the same RLS and
 * the same "only what you may see" rules, for a date range instead of the latest 100.
 * Two shapes -- CSV for a spreadsheet, JSON Lines for a SIEM or an auditor's script --
 * and a trailer that states what the file contains so a truncated copy is detectable.
 * Exporting is itself an audited action (`audit.exported`).
 */
import { csvField } from './dashboard-export.ts';

/** Every action app.audit_events can hold, in the words a person would use. */
export const AUDIT_ACTIONS: Record<string, { text: string; icon: string; tone: string }> = {
  'document.read': { text: 'Dokumen dibuka', icon: 'eye', tone: 'grey' },
  'document.download': { text: 'Unduhan diminta', icon: 'download', tone: 'grey' },
  'document.uploaded': { text: 'Dokumen diunggah', icon: 'upload', tone: 'blue' },
  'upload.rejected': { text: 'Unggahan ditolak', icon: 'alert', tone: 'red' },
  'document.submitted': { text: 'Diajukan untuk review', icon: 'flow', tone: 'blue' },
  'document.revised': { text: 'Revisi dibuat', icon: 'edit', tone: 'blue' },
  'review.approve': { text: 'Review: disetujui', icon: 'check-c', tone: 'green' },
  'review.changes_requested': { text: 'Review: minta revisi', icon: 'refresh', tone: 'amber' },
  'review.reject': { text: 'Review: ditolak', icon: 'x', tone: 'red' },
  'review.finding_resolved': { text: 'Temuan review diselesaikan', icon: 'check', tone: 'green' },
  'document.published': { text: 'Dipublikasikan', icon: 'zap', tone: 'green' },
  'document.withdrawn': { text: 'Dicabut dari publikasi', icon: 'lock', tone: 'amber' },
  'document.reaffirmed': { text: 'Dikonfirmasi masih berlaku', icon: 'check-c', tone: 'green' },
  'document.archived_by_policy': {
    text: 'Diarsipkan otomatis (kebijakan retensi)',
    icon: 'lock',
    tone: 'red',
  },
  'publication.retried': { text: 'Publikasi diulang', icon: 'refresh', tone: 'amber' },
  'document.rolled_back': { text: 'Versi dipulihkan sebagai draft', icon: 'clock', tone: 'amber' },
  'document.feedback': { text: 'Masukan pembaca', icon: 'msg', tone: 'grey' },
  'document.access_changed': { text: 'Grant akses dokumen diubah', icon: 'shield', tone: 'amber' },
  'taxonomy.changed': { text: 'Taksonomi diubah', icon: 'tag', tone: 'blue' },
  'reading.required': { text: 'Bacaan wajib ditetapkan', icon: 'book', tone: 'blue' },
  'reading.acknowledged': { text: 'Bacaan wajib dikonfirmasi', icon: 'check', tone: 'green' },
  'role.created': { text: 'Role kustom dibuat', icon: 'users', tone: 'blue' },
  'role.updated': { text: 'Role kustom diubah', icon: 'users', tone: 'amber' },
  'role.archived': { text: 'Role kustom diarsipkan', icon: 'users', tone: 'grey' },
  'user.activated': { text: 'Akun diaktifkan', icon: 'users', tone: 'green' },
  'user.deactivated': { text: 'Akun dinonaktifkan', icon: 'users', tone: 'red' },
  'user.assignment_changed': { text: 'Role / cakupan diubah', icon: 'users', tone: 'amber' },
  'user.invited': { text: 'Undangan dibuat', icon: 'plus', tone: 'blue' },
  'user.invitation_revoked': { text: 'Undangan dicabut', icon: 'x', tone: 'grey' },
  'user.invitation_accepted': {
    text: 'Undangan diterima, akun aktif',
    icon: 'check-c',
    tone: 'green',
  },
  'access.requested': { text: 'Permintaan akses diajukan', icon: 'lock', tone: 'blue' },
  'access.decided': { text: 'Permintaan akses diputuskan', icon: 'check', tone: 'green' },
  'rag.exported': { text: 'Versi diindeks untuk AI', icon: 'db', tone: 'ai' },
  'rag.unindexed': { text: 'Versi dikeluarkan dari index AI', icon: 'db', tone: 'ai' },
  'rag.retrieval': { text: 'AI: sumber diambil', icon: 'spark', tone: 'ai' },
  'rag.chat': { text: 'AI: jawaban disusun', icon: 'spark', tone: 'ai' },
  'rag.abstained': { text: 'AI: tidak dijawab (tanpa sumber sah)', icon: 'spark', tone: 'amber' },
  'rag.citation_rejected': { text: 'AI: kutipan ditolak validasi', icon: 'shield', tone: 'amber' },
  'rag.answer_helpful': { text: 'AI: jawaban dinilai membantu', icon: 'thumb', tone: 'green' },
  'rag.answer_unhelpful': {
    text: 'AI: jawaban dinilai tidak membantu',
    icon: 'thumb',
    tone: 'amber',
  },
  'audit.exported': { text: 'Audit log diekspor', icon: 'download', tone: 'amber' },
  'ta.import_submitted': { text: 'Impor arsitektur diajukan', icon: 'upload', tone: 'blue' },
  'ta.imported': { text: 'Impor arsitektur disetujui & diterapkan', icon: 'server', tone: 'green' },
  'ta.import_rejected': { text: 'Impor arsitektur ditolak', icon: 'x', tone: 'red' },
  'ta.import_withdrawn': { text: 'Impor arsitektur ditarik', icon: 'x', tone: 'grey' },
};
export const auditLabel = (action: string) =>
  AUDIT_ACTIONS[action] ?? { text: action, icon: 'act', tone: 'grey' };

export interface AuditExportRow {
  id: string;
  createdAt: string;
  action: string;
  actorId: string;
  actorName: string | null;
  documentId: string | null;
  documentTitle: string | null;
  subjectUserId: string | null;
  subjectName: string | null;
}
export interface AuditExportInput {
  generatedAt: string;
  generatedBy: string;
  from: string;
  to: string;
  action: string | null;
  rows: ReadonlyArray<AuditExportRow>;
  /** True when the range held more rows than the file carries. */
  truncated: boolean;
}

/** The filter as the API receives it: an ISO date range of at most a year, an optional action. */
export interface AuditFilter {
  from: Date;
  to: Date;
  action: string | null;
}
export const AUDIT_EXPORT_LIMIT = 50000;
export function parseAuditFilter(params: {
  from?: string | null;
  to?: string | null;
  action?: string | null;
}): AuditFilter {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const now = new Date();
  const to = params.to && day.test(params.to) ? new Date(`${params.to}T23:59:59.999Z`) : now;
  const from =
    params.from && day.test(params.from)
      ? new Date(`${params.from}T00:00:00.000Z`)
      : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    throw new RangeError('Tanggal tidak valid.');
  if (from > to) throw new RangeError('Tanggal awal setelah tanggal akhir.');
  if (to.getTime() - from.getTime() > 366 * 86_400_000)
    throw new RangeError('Rentang ekspor maksimal satu tahun.');
  const action = (params.action ?? '').trim();
  if (action && !(action in AUDIT_ACTIONS)) throw new RangeError('Aktivitas tidak dikenal.');
  return { from, to, action: action || null };
}

const HEADER = [
  'id',
  'waktu_utc',
  'aktivitas',
  'keterangan',
  'pelaku_id',
  'pelaku',
  'dokumen_id',
  'dokumen',
  'subjek_id',
  'subjek',
];
/** A person the exporter may not see is written as such, never as an empty cell. */
const shielded = (name: string | null, id: string | null) =>
  id === null ? '' : (name ?? '(di luar cakupan)');

export function auditCsv(input: AuditExportInput): string {
  const lines = [
    `# IntraDocs audit log,dibuat ${input.generatedAt},oleh ${csvField(input.generatedBy)},rentang ${input.from.slice(0, 10)}..${input.to.slice(0, 10)}${input.action ? ',aktivitas ' + input.action : ''}`,
    HEADER.join(','),
  ];
  for (const r of input.rows)
    lines.push(
      [
        r.id,
        r.createdAt,
        r.action,
        auditLabel(r.action).text,
        r.actorId,
        shielded(r.actorName, r.actorId),
        r.documentId ?? '',
        r.documentId === null ? '' : (r.documentTitle ?? '(di luar cakupan)'),
        r.subjectUserId ?? '',
        shielded(r.subjectName, r.subjectUserId),
      ]
        .map(csvField)
        .join(','),
    );
  lines.push(
    `# ${input.rows.length} baris${input.truncated ? ` (terpotong pada ${AUDIT_EXPORT_LIMIT}; persempit rentang)` : ''}`,
  );
  return lines.join('\r\n') + '\r\n';
}

export function auditJsonl(input: AuditExportInput): string {
  const out = [
    JSON.stringify({
      type: 'header',
      generatedAt: input.generatedAt,
      generatedBy: input.generatedBy,
      from: input.from,
      to: input.to,
      action: input.action,
    }),
  ];
  for (const r of input.rows)
    out.push(
      JSON.stringify({
        type: 'event',
        id: r.id,
        at: r.createdAt,
        action: r.action,
        label: auditLabel(r.action).text,
        actor: { id: r.actorId, name: r.actorName },
        document: r.documentId ? { id: r.documentId, title: r.documentTitle } : null,
        subject: r.subjectUserId ? { id: r.subjectUserId, name: r.subjectName } : null,
      }),
    );
  out.push(
    JSON.stringify({ type: 'trailer', rows: input.rows.length, truncated: input.truncated }),
  );
  return out.join('\n') + '\n';
}
