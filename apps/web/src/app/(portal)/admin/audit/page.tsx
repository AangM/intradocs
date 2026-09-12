import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listAudit } from '@intradocs/db/queries';
import { PageHeading, Empty } from '@/components/shared';
import { Icon } from '@/components/icon';

/** Every action the audit table can hold, in the words a person would use. */
const LABELS: Record<string, { text: string; icon: string; tone: string }> = {
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
  'publication.retried': { text: 'Publikasi diulang', icon: 'refresh', tone: 'amber' },
  'document.rolled_back': { text: 'Versi dipulihkan sebagai draft', icon: 'clock', tone: 'amber' },
  'document.feedback': { text: 'Masukan pembaca', icon: 'msg', tone: 'grey' },
  'document.access_changed': { text: 'Grant akses dokumen diubah', icon: 'shield', tone: 'amber' },
  'taxonomy.changed': { text: 'Taksonomi diubah', icon: 'tag', tone: 'blue' },
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
  'rag.exported': { text: 'Versi diindeks untuk AI', icon: 'db', tone: 'grey' },
  'rag.unindexed': { text: 'Versi dikeluarkan dari index AI', icon: 'db', tone: 'grey' },
  'rag.retrieval': { text: 'AI: sumber diambil', icon: 'spark', tone: 'grey' },
  'rag.chat': { text: 'AI: jawaban disusun', icon: 'spark', tone: 'grey' },
  'rag.abstained': { text: 'AI: tidak dijawab (tanpa sumber sah)', icon: 'spark', tone: 'amber' },
  'rag.citation_rejected': { text: 'AI: kutipan ditolak validasi', icon: 'shield', tone: 'amber' },
  'rag.answer_helpful': { text: 'AI: jawaban dinilai membantu', icon: 'thumb', tone: 'green' },
  'rag.answer_unhelpful': {
    text: 'AI: jawaban dinilai tidak membantu',
    icon: 'thumb',
    tone: 'amber',
  },
};

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(iso));
}

export default async function Audit() {
  const actor = await requireActor('audit.view');
  const events = await listAudit(actor);
  return (
    <div className="pad">
      <PageHeading
        title="Audit Log"
        subtitle="100 event terbaru dalam scope Anda. Isi dokumen, pertanyaan AI, dan credential tidak pernah dicatat."
      />
      <div className="card">
        {events.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Tabel audit yang dapat digulir"
          >
            <table className="tbl audit-table">
              <thead>
                <tr>
                  <th scope="col">Aktivitas</th>
                  <th scope="col">Oleh</th>
                  <th scope="col">Objek</th>
                  <th scope="col">Waktu</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const label = LABELS[e.action] ?? { text: e.action, icon: 'act', tone: 'grey' };
                  return (
                    <tr key={`${e.id}-${i}`}>
                      <td>
                        <span className={`audit-action tone-${label.tone}`}>
                          <Icon name={label.icon} size={14} />
                          {label.text}
                        </span>
                      </td>
                      <td>{e.actorName ?? <span className="sub">Pengguna di luar scope</span>}</td>
                      <td>
                        {e.documentTitle && e.documentHref ? (
                          <Link href={e.documentHref}>{e.documentTitle}</Link>
                        ) : e.subjectName ? (
                          <span>{e.subjectName}</span>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td className="sub">{formatWhen(e.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Belum ada event terlihat">
            Buka dokumen atau unduh Markdown untuk menghasilkan event akses.
          </Empty>
        )}
      </div>
      <p className="sub tiny mt20">
        Setiap baris adalah permintaan yang telah lolos otorisasi. Objek hanya ditampilkan bila Anda
        sendiri boleh membacanya; nama pengguna hanya bila profilnya dalam scope Anda. Retensi
        otomatis belum aktif.
      </p>
    </div>
  );
}
