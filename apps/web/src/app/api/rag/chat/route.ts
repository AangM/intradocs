import { mutation, streamingMutation } from '@/lib/mutation';
import { parseChatBody } from '@intradocs/core/rag';
import { getAiConfig, answerQuestion, type ChatResult } from '@/lib/rag';

// Every turn re-retrieves and re-validates, so a permission change takes effect on the
// next message rather than being masked by an earlier answer. The conversation ID only
// says which IntraDocs-side thread to append to; it carries no context into retrieval.
//
// With `Accept: application/x-ndjson` the same work is streamed: status lines, answer
// fragments as the model writes them (a preview, see AnswerHooks), then the validated
// result as the last line. Without it the response is the JSON result alone.
const shape = (result: ChatResult) => ({
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
  conflicts: result.conflicts,
});

export async function POST(request: Request) {
  const config = getAiConfig();
  const maxChars = config.weknora?.maxQuestionChars ?? 2000;
  const wantsStream = (request.headers.get('accept') ?? '').includes('application/x-ndjson');
  if (!wantsStream)
    return mutation(request, undefined, async (actor, body) => {
      const { question, scope, conversationId } = parseChatBody(body, maxChars);
      return shape(await answerQuestion(actor, question, scope, conversationId));
    });
  return streamingMutation(request, undefined, async (actor, body, emit) => {
    const { question, scope, conversationId } = parseChatBody(body, maxChars);
    const result = await answerQuestion(actor, question, scope, conversationId, {
      status: (stage) => emit({ type: 'status', stage }),
      delta: (text) => emit({ type: 'delta', text }),
    });
    return shape(result);
  });
}
