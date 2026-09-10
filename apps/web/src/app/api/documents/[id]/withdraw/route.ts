import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { objectInput, boundedText } from '@intradocs/core/workflow';
import { withdrawDocument } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    const v = objectInput(body, ['reason']);
    await withdrawDocument(
      actor.id,
      parseUuid((await context.params).id),
      boundedText(v.reason, 10, 2000, 'Alasan pencabutan'),
    );
  });
}
