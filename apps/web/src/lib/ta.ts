import 'server-only';
import { withActor } from '@intradocs/db';
import { readAiConfig } from '@intradocs/core/ai-config';
import { WeknoraClient } from '@intradocs/core/weknora';

/**
 * Semantic search over the Technology Architecture cards in their own WeKnora knowledge
 * base, restricted to the cards of elements this actor may read (RLS on the index
 * entries decides). Returns element ids best-first; the caller reads the elements from
 * the database, so a hit can only ever name a row the actor could already see.
 */
export async function taSemanticSearch(
  actorId: string,
  question: string,
  limit = 5,
): Promise<string[]> {
  const ai = readAiConfig(process.env);
  const kb = process.env.WEKNORA_TA_KNOWLEDGE_BASE_ID ?? '';
  if (!ai.weknora || !kb) return [];
  const entries = await withActor(
    actorId,
    async ({ client }) =>
      (
        await client.query<{ element_id: string; knowledge_id: string }>(
          'SELECT element_id,knowledge_id FROM app.ta_index_entries',
        )
      ).rows,
  );
  if (!entries.length) return [];
  const byKnowledge = new Map(entries.map((e) => [e.knowledge_id, e.element_id]));
  try {
    const hits = await new WeknoraClient({ ...ai.weknora, knowledgeBaseId: kb }).hybridSearch({
      knowledgeIds: entries.map((e) => e.knowledge_id),
      queryText: question,
      matchCount: 12,
    });
    const ids: string[] = [];
    for (const h of hits) {
      const id = byKnowledge.get(h.knowledgeId);
      if (id && !ids.includes(id) && h.chunkType === 'text') ids.push(id);
      if (ids.length >= limit) break;
    }
    return ids;
  } catch {
    // Search is a convenience here; the exact answers do not depend on it.
    return [];
  }
}
export const taSemanticConfigured = () =>
  !!readAiConfig(process.env).weknora && !!process.env.WEKNORA_TA_KNOWLEDGE_BASE_ID;
