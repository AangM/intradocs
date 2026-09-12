import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { listAccessRequests } from '@intradocs/db/access-requests';
import { formatDate } from '@intradocs/core';
import { PageHeading, Empty } from '@/components/shared';
import { AccessRequestForm } from '@/components/access-request-form';
import { AccessRequestDecision } from '@/components/access-request-decision';

const STATE: Record<string, string> = {
  pending: 'Menunggu',
  approved: 'Disetujui',
  declined: 'Ditolak',
  cancelled: 'Dibatalkan',
};
const LEVEL: Record<string, string> = { restricted: 'Terbatas', confidential: 'Rahasia' };

/**
 * Access requests (V1 S02). Everything on this page is read under the actor's own RLS:
 * a requester sees their own requests, an admin additionally sees the queue for the
 * categories they administer. Deciding your own request is refused in SQL.
 */
export default async function AccessRequests() {
  const actor = await requireActor();
  const [categories, requests] = await Promise.all([
    listCategories(actor.id),
    listAccessRequests(actor.id),
  ]);
  const mine = requests.filter((r) => r.requesterId === actor.id);
  const queue = requests.filter((r) => r.requesterId !== actor.id);
  const isAdmin = actor.role === 'super_admin' || actor.role === 'knowledge_admin';

  return (
    <div className="pad">
      <PageHeading
        title="Permintaan Akses"
        subtitle="Ajukan akses ke materi Terbatas atau Rahasia pada kategori yang sudah Anda lihat. Setiap keputusan tercatat beserta alasannya."
      />
      {isAdmin && (
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Menunggu keputusan pada kategori Anda</h2>
          </div>
          <div className="card-b">
            {queue.length ? (
              <ul className="personal-list">
                {queue.map((r) => (
                  <li key={r.id} className="access-queue-item">
                    <div>
                      <div>
                        <strong>{r.requesterName}</strong> meminta{' '}
                        {LEVEL[r.classification] ?? r.classification} pada{' '}
                        <strong>{r.categoryName}</strong> ·{' '}
                        <span className="tag">{STATE[r.state] ?? r.state}</span>
                      </div>
                      <div className="sub tiny">Diajukan {formatDate(r.createdAt)}</div>
                      <p className="sub">{r.reason}</p>
                      {r.state !== 'pending' && r.decisionNote && (
                        <p className="sub">
                          <em>Catatan keputusan:</em> {r.decisionNote}
                        </p>
                      )}
                    </div>
                    {r.state === 'pending' && <AccessRequestDecision id={r.id} />}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Tidak ada antrean">
                Tidak ada permintaan dari orang lain pada kategori yang Anda kelola.
              </Empty>
            )}
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-h">
          <h2 className="h3">Ajukan permintaan</h2>
        </div>
        <div className="card-b">
          <AccessRequestForm categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
        </div>
      </section>

      <section className="card">
        <div className="card-h">
          <h2 className="h3">Permintaan saya</h2>
        </div>
        <div className="card-b">
          {mine.length ? (
            <ul className="personal-list">
              {mine.map((r) => (
                <li key={r.id}>
                  <div>
                    <strong>{r.categoryName}</strong> ·{' '}
                    {LEVEL[r.classification] ?? r.classification} ·{' '}
                    <span className="tag">{STATE[r.state] ?? r.state}</span>
                  </div>
                  <div className="sub tiny">
                    Diajukan {formatDate(r.createdAt)}
                    {r.decidedAt ? ` · diputuskan ${formatDate(r.decidedAt)}` : ''}
                  </div>
                  <p className="sub">{r.reason}</p>
                  {r.decisionNote && (
                    <p className="sub">
                      <em>Catatan keputusan:</em> {r.decisionNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">Belum ada permintaan.</p>
          )}
        </div>
      </section>
    </div>
  );
}
