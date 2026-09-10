import { withActor } from './index.ts';

/**
 * Label suggestions (V1 S07).
 *
 * WeKnora's auto-tagger reads document text with a language model and attaches tags. That
 * makes every tag model output derived from untrusted content, so nothing here treats a
 * tag as a decision:
 *
 *  - a tag only survives if it already exists in `app.labels` for that document's own
 *    category, so a sentence inside a document cannot invent a label;
 *  - a label that has been merged away is never suggested, because it is no longer
 *    offered for new documents either;
 *  - a suggestion is never written. `app.protect_version()` freezes `labels` on every
 *    update, so applying one means creating a revision that a reviewer approves. That is
 *    the point: the model proposes, a person decides.
 *
 * The query runs under the actor's own RLS, so someone who cannot read the document gets
 * an empty result rather than a hint that it exists.
 */

export interface LabelSuggestions {
  /** Labels of this document's category that the tagger picked and the version lacks. */
  suggested: string[];
  /** Tags the tagger produced that are not labels here; reported, never applied. */
  discarded: number;
  /** Labels already on the current version, for the caller to show as context. */
  current: string[];
}

export async function labelSuggestions(
  actorId: string,
  documentId: string,
  tagsFor: (knowledgeId: string) => Promise<string[]>,
): Promise<LabelSuggestions | null> {
  const context = await withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      knowledge_id: string;
      labels: string[] | null;
      vocabulary: string[] | null;
    }>(
      `SELECT e.knowledge_id, v.labels,
        (SELECT array_agg(l.name) FROM app.labels l
          WHERE l.category_id=v.category_id AND l.merged_into IS NULL) AS vocabulary
       FROM app.rag_index_entries e
       JOIN app.document_versions v ON v.id=e.version_id
       WHERE e.document_id=$1`,
      [documentId],
    );
    return rows[0] ?? null;
  });
  // Not readable by this actor, or simply not indexed. Both answer the same way.
  if (!context) return null;

  const current = context.labels ?? [];
  const vocabulary = context.vocabulary ?? [];
  const tags = await tagsFor(context.knowledge_id);

  const suggested: string[] = [];
  let discarded = 0;
  for (const tag of tags) {
    // Match the vocabulary the way the unique index does: case-insensitively, and keep
    // the canonical spelling rather than whatever the model wrote.
    const canonical = vocabulary.find((name) => name.toLowerCase() === tag.toLowerCase());
    if (!canonical) {
      discarded += 1;
      continue;
    }
    if (current.some((name) => name.toLowerCase() === canonical.toLowerCase())) continue;
    if (!suggested.includes(canonical)) suggested.push(canonical);
  }
  return { suggested, discarded, current };
}
