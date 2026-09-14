import { mutation } from '@/lib/mutation';
import { objectInput } from '@intradocs/core/workflow';
import { markAllNotificationsRead } from '@intradocs/db/workflow';
/** Mark every unread notification of the signed-in person as read. */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    objectInput(body, []);
    return { marked: await markAllNotificationsRead(actor.id) };
  });
}
