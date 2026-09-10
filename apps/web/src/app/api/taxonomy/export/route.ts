import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { exportTaxonomy } from '@intradocs/db/taxonomy';

export const dynamic = 'force-dynamic';

/**
 * Downloads the taxonomy this actor may see. RLS decides which categories exist, so the
 * file can never describe a branch outside their scope, and it carries no document
 * titles -- only structure, label names and how many versions use each.
 */
export async function GET() {
  try {
    const actor = await requireApiActor('taxonomy.view');
    const data = await exportTaxonomy(actor.id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="intradocs-taksonomi-${data.exportedAt.slice(0, 10)}.json"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
