import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listNotifications } from '@intradocs/db/workflow';
import { formatDate } from '@intradocs/core';
import { PageHeading, Empty, documentHref } from '@/components/shared';
import { NotificationRead } from '@/components/notification-read';
// The seven kinds app.notifications can hold (migration 005), in a reader's words.
const labels: Record<string, string> = {
  review_assigned: 'Anda ditugaskan mereview',
  review_decided: 'Review diputuskan',
  published: 'Terpublikasi',
  review_due: 'Review berkala jatuh tempo',
  expired: 'Kedaluwarsa',
  feedback: 'Masukan pembaca baru',
  index_failed: 'Indeks gagal — publikasi diulang otomatis',
};
export default async function Notifications() {
  const a = await requireActor(),
    rows = await listNotifications(a.id);
  return (
    <div className="pad">
      <PageHeading
        title="Notifikasi"
        subtitle="Review yang menunggu Anda dan dokumen yang baru terbit."
      />
      {rows.length ? (
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Aktivitas review & publikasi</h2>
          </div>
          <ul className="personal-list">
            {rows.map((n) => (
              <li key={n.id}>
                <div>
                  <p className="hint">
                    {labels[n.kind] ?? n.kind} · {formatDate(n.createdAt)}
                  </p>
                  <Link
                    href={documentHref({ id: n.documentId, slug: n.slug, versionId: n.versionId })}
                  >
                    {n.title}
                  </Link>
                </div>
                <NotificationRead id={n.id} read={n.read} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Empty title="Belum ada notifikasi">
          Permintaan review dan hasil publikasi akan muncul di sini.
        </Empty>
      )}
    </div>
  );
}
