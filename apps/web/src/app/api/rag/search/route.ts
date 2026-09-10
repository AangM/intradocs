import { mutation } from '@/lib/mutation';
import { parseChatBody } from '@intradocs/core/rag';
import { getAiConfig, retrieve } from '@/lib/rag';

// Retrieval only: sources, never a generated answer. The body accepts one field, so a
// client cannot pick a knowledge base, a model or a system prompt.
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    const config = getAiConfig();
    const { question } = parseChatBody(body, config.weknora?.maxQuestionChars ?? 2000);
    const result = await retrieve(actor, question);
    return {
      citations: result.citations,
      rejected: result.rejectedCount,
      scope: result.scopeSize,
    };
  });
}
