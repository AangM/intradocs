import { mutation } from '@/lib/mutation';
import { parseChatBody } from '@intradocs/core/rag';
import { getAiConfig, retrieve } from '@/lib/rag';

// Retrieval only: sources, never a generated answer, and nothing is stored. The body
// accepts a question and an optional narrowing scope, so a client cannot pick a
// knowledge base, a model or a system prompt.
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    const config = getAiConfig();
    const { question, scope } = parseChatBody(body, config.weknora?.maxQuestionChars ?? 2000);
    const result = await retrieve(actor, question, scope);
    return {
      citations: result.citations,
      rejected: result.rejectedCount,
      scope: result.scopeSize,
    };
  });
}
