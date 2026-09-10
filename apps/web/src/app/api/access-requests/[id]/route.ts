import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { decideAccessRequest } from '@intradocs/db/access-requests';

/**
 * Decides a request. Authority, category scope and the refusal to decide your own all
 * live in SQL; a note is required either way so a decline is never unexplained.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = parseUuid((await ctx.params).id);
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'approve,note')
      throw new InputError('Hanya field approve dan note yang diizinkan.');
    if (typeof v.approve !== 'boolean') throw new InputError('approve harus boolean.');
    if (typeof v.note !== 'string' || v.note.trim().length < 5 || v.note.length > 2000)
      throw new InputError('Catatan keputusan wajib diisi 5–2000 karakter.');
    await decideAccessRequest(actor.id, id, v.approve, v.note.trim());
    return { ok: true };
  });
}
