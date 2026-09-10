import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { InputError } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { setFavorite } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, undefined, async (actor, body) => {
    const v = objectInput(body, ['favorite']);
    if (typeof v.favorite !== 'boolean') throw new InputError('Pilihan favorit tidak valid.');
    await setFavorite(actor.id, parseUuid((await context.params).id), v.favorite);
  });
}
