import { withActor } from './index.ts';

/**
 * Non-AI half of "bantuan metadata" (mockup S05): which of the category's labels and
 * which categories the draft text mentions. Pure lexical matching under the actor's RLS
 * -- the text never leaves IntraDocs, and the vocabulary consulted is exactly the one the
 * actor may upload into.
 */

export interface MetadataHints {
  /** Labels of the chosen category whose names occur in the text, most frequent first. */
  labels: string[];
  /** Categories the actor may upload into, scored by how many of their labels the text mentions. */
  categories: Array<{ id: string; name: string; score: number }>;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length < 3) return 0;
  let n = 0,
    at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) {
    n += 1;
    at += needle.length;
  }
  return n;
}

export async function metadataHints(
  actorId: string,
  text: string,
  categoryId: string | null,
): Promise<MetadataHints> {
  const lower = text.toLowerCase();
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      category_id: string;
      category_name: string;
    }>(
      `SELECT l.id,l.name,l.category_id,c.name AS category_name
       FROM app.labels l JOIN app.categories c ON c.id=l.category_id
       WHERE l.merged_into IS NULL AND app.can_upload_to(c.id)`,
    );
    const byCategory = new Map<string, { name: string; score: number }>();
    const labelHits: Array<{ name: string; count: number }> = [];
    for (const r of rows) {
      const count = occurrences(lower, r.name.toLowerCase());
      const entry = byCategory.get(r.category_id) ?? { name: r.category_name, score: 0 };
      entry.score += count;
      byCategory.set(r.category_id, entry);
      if (count > 0 && r.category_id === categoryId) labelHits.push({ name: r.name, count });
    }
    return {
      labels: labelHits.sort((a, b) => b.count - a.count).map((l) => l.name),
      categories: [...byCategory.entries()]
        .map(([id, c]) => ({ id, name: c.name, score: c.score }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3),
    };
  });
}
