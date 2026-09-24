import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { decideTaImport } from '@intradocs/db/ta';

/**
 * Decide a proposed import: approve (the change set is applied), reject (a reason of at
 * least ten characters), or withdraw (the proposer's own). The database enforces that
 * the approver is a different admin of the category.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutation(request, 'taxonomy.view', async (actor, body) => {
    const id = parseUuid((await context.params).id);
    const v = objectInput(body, ['decision', 'note']);
    if (v.decision !== 'approve' && v.decision !== 'reject' && v.decision !== 'withdraw')
      throw new InputError('Keputusan tidak dikenal.');
    if (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > 2000))
      throw new InputError('Catatan maksimal 2000 karakter.');
    return decideTaImport(actor.id, id, v.decision, typeof v.note === 'string' ? v.note : null);
  });
}
