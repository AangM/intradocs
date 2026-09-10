import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { setDocumentAccess } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    const v = objectInput(body, ['member', 'grant']);
    if (
      typeof v.member !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(v.member) ||
      typeof v.grant !== 'boolean'
    )
      throw new InputError('Grant tidak valid.');
    await setDocumentAccess(actor.id, parseUuid((await context.params).id), v.member, v.grant);
  });
}
