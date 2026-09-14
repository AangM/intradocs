import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listNotifications } from '@intradocs/db/workflow';
import { formatDate, formatRelative } from '@intradocs/core';
import { PageHeading, Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { NotificationRead, MarkAllRead } from '@/components/notification-read';
import { NOTIFICATION_KINDS } from '@/components/notification-kinds';

const DAY = 86_400_000;
async function currentTime() {
  return Date.now();
}
/** Today, the last week, and everything before: enough grouping to skim a list. */
function groupOf(createdAt: string, now: number): 'Hari ini' | '7 hari terakhir' | 'Sebelumnya' {
  const age = now - new Date(createdAt).getTime();
  return age < DAY ? 'Hari ini' : age < 7 * DAY ? '7 hari terakhir' : 'Sebelumnya';
}

export default async function Notifications() {
  const a = await requireActor(),
    rows = await listNotifications(a.id);
  const unread = rows.filter((n) => !n.read).length;
  // Server component: the grouping is decided once per request, not on re-render.
  const now = await currentTime();
  const groups = ['Hari ini', '7 hari terakhir', 'Sebelumnya'] as const;
  return (
    <div className="pad">
      <PageHeading
        title="Notifikasi"
        subtitle={
          unread
            ? `${unread} belum dibaca · review yang menunggu Anda dan dokumen yang baru terbit.`
            : 'Review yang menunggu Anda dan dokumen yang baru terbit.'
        }
        actions={unread > 0 ? <MarkAllRead /> : undefined}
      />
      {rows.length ? (
        <section className="card nt-card">
          {groups.map((group) => {
            const items = rows.filter((n) => groupOf(n.createdAt, now) === group);
            if (!items.length) return null;
            return (
              <div key={group} className="card-b" style={{ paddingTop: 0, paddingBottom: 0 }}>
                <h2 className="nt-group">{group}</h2>
                <ul className="nt-list">
                  {items.map((n) => {
                    const kind = NOTIFICATION_KINDS[n.kind] ?? NOTIFICATION_KINDS.default!;
                    return (
                      <li key={n.id} className={`nt-row ${n.read ? '' : 'unread'}`}>
                        <span className={`nt-ic ${kind.tone}`} aria-hidden="true">
                          <Icon name={kind.icon} size={15} />
                        </span>
                        <div>
                          <div className="nt-t">
                            {!n.read && (
                              <>
                                <span className="nt-dot" aria-hidden="true" />
                                <span className="sr-only">Belum dibaca: </span>
                              </>
                            )}
                            <Link
                              href={documentHref({
                                id: n.documentId,
                                slug: n.slug,
                                versionId: n.versionId,
                              })}
                            >
                              {n.title}
                            </Link>
                          </div>
                          <div className="nt-m">
                            {kind.label} ·{' '}
                            <time dateTime={n.createdAt} title={formatDate(n.createdAt)}>
                              {formatRelative(n.createdAt)}
                            </time>
                          </div>
                        </div>
                        <NotificationRead id={n.id} read={n.read} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      ) : (
        <Empty title="Belum ada notifikasi">
          Permintaan review dan hasil publikasi akan muncul di sini.
        </Empty>
      )}
    </div>
  );
}
