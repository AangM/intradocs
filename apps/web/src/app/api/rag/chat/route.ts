import { mutation } from '@/lib/mutation';
import { parseChatBody } from '@intradocs/core/rag';
import { getAiConfig, answerQuestion } from '@/lib/rag';

// Every turn re-retrieves and re-validates, so a permission change takes effect on the
// next message rather than being masked by an earlier answer. The conversation ID only
// says which IntraDocs-side thread to append to; it carries no context into retrieval.
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    const config = getAiConfig();
    const { question, scope, conversationId } = parseChatBody(
      body,
      config.weknora?.maxQuestionChars ?? 2000,
    );
    const result = await answerQuestion(actor, question, scope, conversationId);
    return {
      conversationId: result.conversationId,
      turnId: result.turnId,
      mode: result.mode,
      answer: result.answer,
      abstained: result.abstained,
      citations: result.citations,
      rejectedCount: result.rejectedCount,
      scopeSize: result.scopeSize,
      related: result.related,
      suggestions: result.suggestions,
    };
  });
}
