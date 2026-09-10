import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { restoreVersion } from '@/lib/versions';

/**
 * Opens a new draft from an earlier approved version. Only the document owner may do it,
 * enforced in SQL; nothing is republished here, so the restored text still has to pass
 * review before it can reach a reader.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const documentId = parseUuid((await ctx.params).id);
  return mutation(request, 'documents.upload', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const keys = Object.keys(body as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== 'versionId')
      throw new InputError('Hanya field versionId yang diizinkan.');
    const versionId = parseUuid((body as { versionId: unknown }).versionId);
    return restoreVersion(actor, documentId, versionId);
  });
}
