import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { sidebarCounts } from '@intradocs/db/workflow';
import { Shell } from '@/components/shell';
import { aiStatus } from '@/lib/rag';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const [categories, counts] = await Promise.all([
    listCategories(actor.id),
    sidebarCounts(actor.id),
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
      }}
    >
      {children}
    </Shell>
  );
}
