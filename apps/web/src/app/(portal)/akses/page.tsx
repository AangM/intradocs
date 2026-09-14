import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { listAccessRequests } from '@intradocs/db/access-requests';
import { formatDate, formatRelative } from '@intradocs/core';
import { PageHeading, Empty } from '@/components/shared';
import { Icon } from '@/components/icon';
import { AccessRequestForm } from '@/components/access-request-form';
import { AccessRequestDecision } from '@/components/access-request-decision';

/** State → chip: the flow colours, so "menunggu" reads amber here as everywhere else. */
const STATE: Record<string, { label: string; pill: string; icon: string; tone: string }> = {
  pending: { label: 'Menunggu', pill: 'p-amber', icon: 'clock', tone: 'nt-review' },
  approved: { label: 'Disetujui', pill: 'p-green', icon: 'check-c', tone: 'nt-ok' },
  declined: { label: 'Ditolak', pill: 'p-red', icon: 'x', tone: 'nt-block' },
  cancelled: { label: 'Dibatalkan', pill: 'p-grey', icon: 'x', tone: '' },
};
const LEVEL: Record<string, string> = { restricted: 'Terbatas', confidential: 'Rahasia' };
type Row = Awaited<ReturnType<typeof listAccessRequests>>[number];

function StateChip({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, pill: 'p-grey', icon: 'clock', tone: '' };
  return <span className={`pill ${s.pill}`}>{s.label}</span>;
}

/** One request as a row: who/what, when, the reason, and the note once decided. */
function RequestRow({ r, mine, children }: { r: Row; mine: boolean; children?: React.ReactNode }) {
  const s = STATE[r.state] ?? STATE.pending!;
  return (
    <li className={`acc-row ${r.state === 'pending' ? 'pending' : ''}`}>
      <span className={`nt-ic ${s.tone}`} aria-hidden="true">
        <Icon name={s.icon} size={15} />
      </span>
      <div>
        <div className="acc-t">
          {mine ? (
            <span>
              {LEVEL[r.classification] ?? r.classification} · {r.categoryName}
            </span>
          ) : (
            <span>
              {r.requesterName} · {LEVEL[r.classification] ?? r.classification} · {r.categoryName}
            </span>
          )}
          <StateChip state={r.state} />
        </div>
        <div className="acc-m">
          Diajukan{' '}
          <time dateTime={r.createdAt} title={formatDate(r.createdAt)}>
            {formatRelative(r.createdAt)}
          </time>
          {r.decidedAt ? ` · diputuskan ${formatDate(r.decidedAt)}` : ''}
        </div>
        <p className="acc-reason">{r.reason}</p>
        {r.state !== 'pending' && r.decisionNote && (
          <p className="acc-note">
            <strong>Catatan keputusan:</strong> {r.decisionNote}
          </p>
        )}
      </div>
      {children}
    </li>
  );
}

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
  const others = requests.filter((r) => r.requesterId !== actor.id);
  const queue = others.filter((r) => r.state === 'pending');
  const history = others.filter((r) => r.state !== 'pending');
  const isAdmin = actor.role === 'super_admin' || actor.role === 'knowledge_admin';

  return (
    <div className="pad">
      <PageHeading
        title="Permintaan Akses"
        subtitle="Minta akses ke dokumen Terbatas atau Rahasia; setiap keputusan tercatat."
      />
      <div className="access-layout">
        <div>
          {isAdmin && (
            <section className="card">
              <div className="card-h">
                <h2 className="h3">
                  Menunggu keputusan Anda
                  {queue.length > 0 && <span className="pill p-amber">{queue.length}</span>}
                </h2>
              </div>
              {queue.length ? (
                <ul className="nt-list">
                  {queue.map((r) => (
                    <RequestRow key={r.id} r={r} mine={false}>
                      <div className="acc-decide">
                        <AccessRequestDecision id={r.id} />
                      </div>
                    </RequestRow>
                  ))}
                </ul>
              ) : (
                <Empty title="Tidak ada antrean">
                  Tidak ada permintaan dari orang lain pada kategori yang Anda kelola.
                </Empty>
              )}
              {history.length > 0 && (
                <details className="acc-history">
                  <summary>
                    <Icon name="clock" size={13} />
                    Riwayat keputusan ({history.length})
                  </summary>
                  <ul className="nt-list">
                    {history.map((r) => (
                      <RequestRow key={r.id} r={r} mine={false} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <section className="card">
            <div className="card-h">
              <h2 className="h3">Permintaan saya</h2>
            </div>
            {mine.length ? (
              <ul className="nt-list">
                {mine.map((r) => (
                  <RequestRow key={r.id} r={r} mine />
                ))}
              </ul>
            ) : (
              <Empty title="Belum ada permintaan">
                Permintaan yang Anda ajukan dan keputusannya muncul di sini.
              </Empty>
            )}
          </section>
        </div>
        <section className="card access-form">
          <div className="card-h">
            <h2 className="h3">
              <Icon name="lock" size={16} />
              Ajukan permintaan
            </h2>
          </div>
          <div className="card-b">
            <AccessRequestForm categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
          </div>
        </section>
      </div>
    </div>
  );
}
