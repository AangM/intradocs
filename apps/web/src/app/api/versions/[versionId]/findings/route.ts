import { mutation } from '@/lib/mutation';
import { parseUuid } from '@intradocs/core/validation';
import { InputError } from '@intradocs/core/validation';
import { objectInput, boundedText } from '@intradocs/core/workflow';
import { resolveFinding } from '@intradocs/db/workflow';
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  return mutation(request, 'documents.review', async (actor, body) => {
    const v = objectInput(body, ['fingerprint', 'reason']);
    if (typeof v.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint))
      throw new InputError('Temuan tidak valid.');
    await resolveFinding(
      actor.id,
      parseUuid((await context.params).versionId),
      v.fingerprint,
      boundedText(v.reason, 10, 2000, 'Justifikasi'),
    );
  });
}
