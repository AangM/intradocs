import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { listNotifications, sidebarCounts } from '@intradocs/db/workflow';
import { taPendingCount } from '@intradocs/db/ta';
import { hasCapability } from '@intradocs/core';
import { formatRelative } from '@intradocs/core';
import { Shell } from '@/components/shell';
import { aiStatus } from '@/lib/rag';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const [categories, counts, recent, taPending] = await Promise.all([
    listCategories(actor.id),
    sidebarCounts(actor.id),
    listNotifications(actor.id, 5),
    hasCapability(actor, 'taxonomy.view') ? taPendingCount(actor.id) : Promise.resolve(0),
  ]);
  const ai = aiStatus();
  return (
    <Shell
      actor={actor}
      categories={categories}
      aiOn={ai.retrieval !== 'off'}
      counts={{
        '/notifikasi': counts.notifications,
        '/admin/approval': counts.approvals,
        '/katalog?status=mine': counts.drafts,
        '/arsitektur': taPending,
      }}
      recent={recent.map((n) => ({
        id: n.id,
        kind: n.kind,
        read: n.read,
        title: n.title,
        documentId: n.documentId,
        slug: n.slug,
        versionId: n.versionId,
        when: formatRelative(n.createdAt),
      }))}
    >
      {children}
    </Shell>
  );
}
