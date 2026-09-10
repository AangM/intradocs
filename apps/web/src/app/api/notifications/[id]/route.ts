import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { markNotificationRead } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, undefined, async (actor, body) => {
    objectInput(body, []);
    await markNotificationRead(actor.id, parseUuid((await context.params).id));
  });
}
