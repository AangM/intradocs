import { mutation } from '@/lib/mutation';
import { parseScope } from '@intradocs/core/rag';
import { InputError } from '@intradocs/core/validation';
import { WeknoraClient } from '@intradocs/core/weknora';
import { scopedSources } from '@intradocs/db/insights';
import { getAiConfig } from '@/lib/rag';

const MAX_SOURCES = 4;
const PER_SOURCE = 2;

/**
 * Starter questions for the assistant, drawn from what WeKnora generated for the
 * versions inside the actor's chosen scope. The scope is resolved through the same
 * RLS-filtered query retrieval uses, so a question can only ever come from a document
 * the actor may read; asking it still goes through the full gate.
 */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).join(',') !== 'scope')
      throw new InputError('Hanya field scope yang diizinkan.');
    const scope = parseScope(v.scope);

    const config = getAiConfig();
    const weknora = config.retrieval === 'weknora-local' ? config.weknora : null;
    if (!weknora) return { questions: [] };

    const client = new WeknoraClient(weknora);
    const sources = await scopedSources(actor.id, scope, MAX_SOURCES);
    const questions: Array<{ question: string; documentTitle: string }> = [];
    for (const source of sources) {
      const generated = await client
        .knowledgeGenerated(source.knowledgeId, { maxSummaryChars: 0, maxQuestions: PER_SOURCE })
        .catch(() => null);
      for (const question of generated?.questions ?? [])
        if (!questions.some((q) => q.question === question))
          questions.push({ question, documentTitle: source.documentTitle });
    }
    return { questions };
  });
}
