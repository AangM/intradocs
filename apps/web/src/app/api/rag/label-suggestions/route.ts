import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { WeknoraClient } from '@intradocs/core/weknora';
import { labelSuggestions } from '@intradocs/db/label-suggestions';
import { getAiConfig } from '@/lib/rag';

/**
 * Label suggestions for one document (V1 S07).
 *
 * The tags come from a language model that read the document, so they are treated as
 * data throughout: the database keeps only the ones that are already labels of that
 * document's own category, and nothing is written. Applying a suggestion still means
 * creating a revision, because `app.protect_version()` freezes labels on a published one.
 *
 * POST rather than GET so the same origin check and session handling as every other
 * mutation applies, and so a document id never lands in a URL or a server log.
 */
export async function POST(request: Request) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).join(',') !== 'documentId')
      throw new InputError('Hanya field documentId yang diizinkan.');
    const documentId = parseUuid(v.documentId);

    const config = getAiConfig();
    // AI off is not an error here; it means there is nothing to suggest.
    const weknora = config.retrieval === 'weknora-local' ? config.weknora : null;
    if (!weknora) return { available: false, suggested: [], discarded: 0, current: [] };

    const client = new WeknoraClient(weknora);
    const result = await labelSuggestions(actor.id, documentId, (knowledgeId) =>
      client.knowledgeTags(knowledgeId),
    );
    // Unreadable and never-indexed answer identically, so this reveals nothing.
    if (!result) return { available: false, suggested: [], discarded: 0, current: [] };
    return { available: true, ...result };
  });
}
