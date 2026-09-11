import { mutation } from '@/lib/mutation';
import { parseChatBody } from '@intradocs/core/rag';
import { getAiConfig, answerQuestion } from '@/lib/rag';

// One turn, no history. Every turn re-retrieves and re-validates, so a permission change
// takes effect on the next message rather than being masked by an earlier answer.
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    const config = getAiConfig();
    const { question } = parseChatBody(body, config.weknora?.maxQuestionChars ?? 2000);
    const result = await answerQuestion(actor, question);
    return {
      mode: result.mode,
      answer: result.answer,
      abstained: result.abstained,
      citations: result.citations,
      rejectedCount: result.rejectedCount,
      scopeSize: result.scopeSize,
    };
  });
}
