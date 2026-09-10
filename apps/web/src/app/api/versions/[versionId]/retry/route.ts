import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { retryPublication } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    objectInput(body, []);
    await retryPublication(actor.id, parseUuid((await context.params).versionId));
  });
}
