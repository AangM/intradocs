import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { Shell } from '@/components/shell';
import { aiStatus } from '@/lib/rag';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const categories = await listCategories(actor.id);
  const ai = aiStatus();
  return (
    <Shell actor={actor} categories={categories} aiOn={ai.retrieval !== 'off'}>
      {children}
    </Shell>
  );
}
