import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { createAccessRequest } from '@intradocs/db/access-requests';

/**
 * Raises a request for access to a category the requester can already see.
 *
 * The category is validated by RLS, not here: the insert policy requires
 * app.in_category(category_id), so naming a category outside scope fails rather than
 * confirming that it exists.
 */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(',');
    if (keys !== 'categoryId,classification,reason')
      throw new InputError('Hanya field categoryId, classification dan reason yang diizinkan.');
    if (v.classification !== 'restricted' && v.classification !== 'confidential')
      throw new InputError('Level akses tidak valid.');
    if (typeof v.reason !== 'string' || v.reason.trim().length < 20 || v.reason.length > 2000)
      throw new InputError('Alasan wajib diisi 20–2000 karakter.');
    return createAccessRequest(actor.id, {
      categoryId: parseUuid(v.categoryId),
      classification: v.classification,
      reason: v.reason.trim(),
    });
  });
}
