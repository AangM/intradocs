import { mutation } from '@/lib/mutation';
import { InputError } from '@intradocs/core/validation';
import { parseAssignment } from '@intradocs/core/taxonomy';
import { assignUser } from '@intradocs/db/taxonomy';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'users.view', async (actor, body) => {
    const id = (await context.params).id;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new InputError('Pengguna tidak valid.');
    await assignUser(actor.id, id, parseAssignment(body));
  });
}
