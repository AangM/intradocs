import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { withdrawDocuments } from '@intradocs/db/workflow';

/**
 * Withdraws several documents in one transaction.
 *
 * The client sends ids and a reason and nothing else. Ownership, scope and the reason
 * rules are the ones app.withdraw_document already enforces per document; the batch adds
 * a cap and all-or-nothing semantics so a refusal never leaves half the selection done.
 */
export async function POST(request: Request) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'documentIds,reason')
      throw new InputError('Hanya field documentIds dan reason yang diizinkan.');
    if (!Array.isArray(v.documentIds) || v.documentIds.length === 0 || v.documentIds.length > 25)
      throw new InputError('Pilih 1–25 dokumen.');
    if (typeof v.reason !== 'string' || v.reason.trim().length < 10 || v.reason.length > 2000)
      throw new InputError('Alasan pencabutan wajib diisi 10–2000 karakter.');
    const ids = v.documentIds.map((id) => parseUuid(id));
    if (new Set(ids).size !== ids.length) throw new InputError('Ada dokumen terpilih dua kali.');
    return withdrawDocuments(actor.id, ids, v.reason.trim());
  });
}
