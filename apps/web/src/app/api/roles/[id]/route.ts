import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { parseCustomRole, parseRevision } from '@intradocs/core/roles';
import { archiveCustomRole, saveCustomRole } from '@intradocs/db/roles';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'users.manage', async (actor, body) => {
    const id = parseUuid((await context.params).id);
    const v = parseCustomRole(body, true);
    await saveCustomRole(actor.id, { ...v, id });
  });
}

/** Archives the role; SQL refuses while anyone still holds it. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'users.manage', async (actor, body) => {
    const id = parseUuid((await context.params).id);
    const v = objectInput(body, ['revision']);
    await archiveCustomRole(actor.id, id, parseRevision(v.revision));
  });
}
