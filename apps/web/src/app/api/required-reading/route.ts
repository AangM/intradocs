import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { createRequirement } from '@intradocs/db/required-reading';

/**
 * Marks a document as required reading for one category.
 *
 * Authority, category scope and readability of the document are all enforced by the RLS
 * insert policy, so pointing a requirement at something out of scope fails rather than
 * confirming it exists.
 */
export async function POST(request: Request) {
  return mutation(request, 'taxonomy.view', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(',');
    if (keys !== 'categoryId,documentId,dueAt,note')
      throw new InputError('Hanya field documentId, categoryId, note dan dueAt yang diizinkan.');
    if (typeof v.note !== 'string' || v.note.trim().length < 10 || v.note.length > 500)
      throw new InputError('Catatan wajib diisi 10–500 karakter.');
    let dueAt: string | null = null;
    if (v.dueAt !== null) {
      if (typeof v.dueAt !== 'string' || Number.isNaN(Date.parse(v.dueAt)))
        throw new InputError('Tenggat tidak valid.');
      dueAt = new Date(v.dueAt).toISOString();
    }
    return createRequirement(actor.id, {
      documentId: parseUuid(v.documentId),
      categoryId: parseUuid(v.categoryId),
      note: v.note.trim(),
      dueAt,
    });
  });
}
