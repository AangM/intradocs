import { mutation } from '@/lib/mutation';
import { InputError } from '@intradocs/core/validation';
import { objectInput } from '@intradocs/core/workflow';
import { answerTaQuestion } from '@intradocs/core/ta';
import { taModel } from '@intradocs/db/ta';
import { taSemanticSearch } from '@/lib/ta';

/**
 * A question about the Technology Architecture model. Answered from the data the actor
 * may see: impact and dependency walks, end of support, inventory, or one element. When
 * the question names nothing the rules recognise, semantic search over the element cards
 * suggests the closest elements -- still rows from the database, never generated text.
 */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    const v = objectInput(body, ['question']);
    const question = typeof v.question === 'string' ? v.question.trim() : '';
    if (question.length < 2 || question.length > 500)
      throw new InputError('Tulis pertanyaan 2–500 karakter.');
    const { elements, relations } = await taModel(actor.id);
    const answer = answerTaQuestion(question, elements, relations, new Date());
    const ref = (e: { id: string; name: string; kind: string }) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
    });
    if (answer.type !== 'none') {
      return {
        type: answer.type,
        text: answer.text,
        subject: 'subject' in answer ? ref(answer.subject) : null,
        filter: 'filter' in answer ? answer.filter : null,
        items:
          answer.type === 'impact' || answer.type === 'dependencies'
            ? answer.items.map((i) => ({ ...ref(i.element), depth: i.depth, via: i.via }))
            : answer.type === 'list'
              ? answer.items.map(ref)
              : [],
        semantic: false,
      };
    }
    const ids = await taSemanticSearch(actor.id, question);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((e) => !!e)
      .map((e) => ref(e!));
    return {
      type: items.length ? 'suggest' : 'none',
      text: items.length
        ? 'Tidak ada jawaban pasti dari aturan; elemen yang paling mirip dengan pertanyaan Anda:'
        : answer.text,
      subject: null,
      filter: null,
      items,
      semantic: items.length > 0,
    };
  });
}
