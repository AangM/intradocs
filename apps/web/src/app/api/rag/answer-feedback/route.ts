import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { voteTurn } from '@intradocs/db/assistant';

/**
 * "Membantu / tidak" on one of the actor's own answers. The vote lives on the turn and
 * in the audit trail as a count; an unhelpful answer also feeds the knowledge-gap
 * aggregate the same way an unanswered search does. A turn that is not the actor's is
 * invisible under RLS and answers 404.
 */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'helpful,turnId')
      throw new InputError('Hanya field turnId dan helpful yang diizinkan.');
    if (typeof v.helpful !== 'boolean') throw new InputError('helpful harus boolean.');
    const turnId = parseUuid(v.turnId);
    const ok = await voteTurn(actor.id, turnId, v.helpful);
    if (!ok) throw new InputError('Jawaban tidak ditemukan.');
    return { ok: true };
  });
}
