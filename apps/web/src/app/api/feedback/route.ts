import { mutation } from '@/lib/mutation';
import { parseFeedback } from '@intradocs/core/workflow';
import { saveFeedback } from '@intradocs/db/workflow';
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    await saveFeedback(actor.id, parseFeedback(body));
  });
}
