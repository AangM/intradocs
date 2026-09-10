import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { acknowledgeReading } from '@intradocs/db/required-reading';

/**
 * Records that the signed-in person says they read it. The version must be retrievable
 * right now, so an acknowledgement always names something that was actually readable.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = parseUuid((await ctx.params).id);
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).join(',') !== 'versionId')
      throw new InputError('Hanya field versionId yang diizinkan.');
    await acknowledgeReading(actor.id, id, parseUuid(v.versionId));
    return { ok: true };
  });
}
