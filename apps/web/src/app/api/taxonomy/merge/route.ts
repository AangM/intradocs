import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { mergeLabels } from '@intradocs/db/taxonomy';

/**
 * Consolidates two labels of one category. Authority, category scope and the optimistic
 * revision check all live in SQL; this route only validates the shape of the request.
 */
export async function POST(request: Request) {
  return mutation(request, 'taxonomy.view', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    const keys = Object.keys(v).sort();
    if (keys.length !== 3 || keys.join(',') !== 'revision,source,target')
      throw new InputError('Hanya field source, target dan revision yang diizinkan.');
    if (typeof v.revision !== 'number' || !Number.isInteger(v.revision) || v.revision < 0)
      throw new InputError('Revision tidak valid.');
    return mergeLabels(actor.id, parseUuid(v.source), parseUuid(v.target), v.revision);
  });
}
