import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { reaffirmVersion } from '@intradocs/db/workflow';
/**
 * "Still valid": the owner moves the review date forward without re-publishing. The
 * database checks that it is the current published version, that the review is near or
 * past, and that the caller owns it; an expired version is refused (it needs a new one).
 */
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    const id = parseUuid((await context.params).versionId);
    objectInput(body, []);
    const reviewAt = await reaffirmVersion(actor.id, id);
    return { reviewAt };
  });
}
