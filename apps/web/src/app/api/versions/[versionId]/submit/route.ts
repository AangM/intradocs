import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { parseSubmit, WorkflowError, objectInput } from '@intradocs/core/workflow';
import { submitVersion } from '@intradocs/db/workflow';
import { readVersionFile } from '@intradocs/db/queries';
import { getStorage } from '@/lib/storage';
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    const id = parseUuid((await context.params).versionId);
    const v = objectInput(body, ['reviewers', 'reviewAt', 'expiresAt', 'confirmed']);
    if (v.confirmed !== true)
      throw new WorkflowError(
        'Tinjau original, Markdown, dan seluruh lampiran sebelum mengajukan.',
        422,
      );
    const input = parseSubmit({
      versionId: id,
      reviewers: v.reviewers,
      reviewAt: v.reviewAt,
      expiresAt: v.expiresAt,
    });
    const file = await readVersionFile(actor.id, id);
    if (!file) throw new WorkflowError('Dokumen tidak tersedia.', 404);
    const markdown = Buffer.from(await getStorage().read(file.key, file.hash)).toString('utf8');
    const requestId = await submitVersion(actor.id, input, markdown);
    return { requestId, state: 'in_review' };
  });
}
