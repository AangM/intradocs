import { requireActor } from '@/lib/session';
import { listAudit } from '@intradocs/db/queries';
import { PageHeading, Empty } from '@/components/shared';
import { formatDate } from '@intradocs/core';
const labels: Record<string, string> = {
  'document.read': 'Dokumen dibuka',
  'document.download': 'Unduhan diminta',
  'user.activated': 'Akun diaktifkan',
  'user.deactivated': 'Akun dinonaktifkan',
};
export default async function Audit() {
  const actor = await requireActor('audit.view');
  const events = await listAudit(actor);
  return (
    <div className="pad">
      <PageHeading
        title="Audit Log"
        subtitle="Maksimal 50 event terbaru sesuai scope. Isi dokumen dan credential tidak dicatat."
      />
      <div className="card">
        {events.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Tabel yang dapat digulir"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Aktivitas</th>
                  <th scope="col">Tanggal</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.id.slice(0, 8)}</td>
                    <td>{labels[e.action] ?? 'Aktivitas'}</td>
                    <td>{formatDate(e.createdAt)}</td>
                  </tr>
                ))}
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
        Audit akses saat ini mencatat permintaan yang telah lolos otorisasi, bukan bukti bahwa
        seluruh file berhasil diterima. Retensi otomatis belum aktif.
      </p>
    </div>
  );
}
