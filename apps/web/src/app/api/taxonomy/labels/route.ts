import { mutation } from '@/lib/mutation';
import { parseLabel } from '@intradocs/core/taxonomy';
import { saveLabel } from '@intradocs/db/taxonomy';
export async function POST(request: Request) {
  return mutation(request, 'taxonomy.view', async (actor, body) => ({
    id: await saveLabel(actor.id, parseLabel(body)),
  }));
}
