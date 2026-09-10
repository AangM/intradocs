import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { parseDecision, objectInput } from '@intradocs/core/workflow';
import { decideVersion } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  return mutation(request, 'documents.review', async (actor, body) => {
    const v = objectInput(body, ['decision', 'reason']);
    return {
      state: await decideVersion(
        actor.id,
        parseDecision({ ...v, versionId: parseUuid((await context.params).versionId) }),
      ),
    };
  });
}
