import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { parseCategory, positiveInteger } from '@intradocs/core/taxonomy';
import { objectInput } from '@intradocs/core/workflow';
import { saveCategory, deleteCategory } from '@intradocs/db/taxonomy';
export async function POST(request: Request) {
  return mutation(request, 'taxonomy.view', async (actor, body) => ({
    id: await saveCategory(actor.id, parseCategory(body)),
  }));
}
export async function DELETE(request: Request) {
  return mutation(request, 'taxonomy.view', async (actor, body) => {
    const v = objectInput(body, ['id', 'revision']);
    await deleteCategory(actor.id, parseUuid(v.id), positiveInteger(v.revision, 1, 1000000));
  });
}
