import { withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';
import type { parseCategory, parseLabel, parseAssignment } from '@intradocs/core/taxonomy';
export type TaxonomyCategory = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  minimumClassification: string;
  approvalSteps: number;
  reviewDays: number;
  position: number;
  revision: number;
};
export type TaxonomyLabel = {
  id: string;
  categoryId: string;
  name: string;
  color: string;
  revision: number;
};
export async function taxonomyData(
  actorId: string,
): Promise<{ categories: TaxonomyCategory[]; labels: TaxonomyLabel[] }> {
  return withActor(actorId, async ({ client }) => {
    const categories = (await client.query('SELECT * FROM app.categories ORDER BY position,name'))
      .rows;
    const labels = (await client.query('SELECT * FROM app.labels ORDER BY name')).rows;
    return {
      categories: categories.map((c) => ({
        id: c.id,
        parentId: c.parent_id,
        name: c.name,
        description: c.description,
        minimumClassification: c.minimum_classification,
        approvalSteps: c.approval_steps,
        reviewDays: c.review_days,
        position: c.position,
        revision: c.revision,
      })),
      labels: labels.map((l) => ({
        id: l.id,
        categoryId: l.category_id,
        name: l.name,
        color: l.color,
        revision: l.revision,
      })),
    };
  });
}
export async function saveCategory(actorId: string, v: ReturnType<typeof parseCategory>) {
  try {
    return await withActor(
      actorId,
      async ({ client }) =>
        (
          await client.query<{ id: string }>(
            'SELECT app.save_category($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
            [
              v.id,
              v.revision,
              v.parentId,
              v.name,
              v.description,
              v.minimumClassification,
              v.approvalSteps,
              v.reviewDays,
              v.position,
              v.confirmTightening,
            ],
          )
        ).rows[0]!.id,
    );
  } catch (e) {
    translateWorkflowError(e);
  }
}
export async function deleteCategory(actorId: string, id: string, revision: number) {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query('SELECT app.delete_category($1,$2)', [id, revision]);
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
export async function saveLabel(actorId: string, v: ReturnType<typeof parseLabel>) {
  try {
    return await withActor(
      actorId,
      async ({ client }) =>
        (
          await client.query<{ id: string }>('SELECT app.save_label($1,$2,$3,$4,$5,$6) AS id', [
            v.id,
            v.revision,
            v.categoryId,
            v.name,
            v.color,
            v.remove,
          ])
        ).rows[0]!.id,
    );
  } catch (e) {
    translateWorkflowError(e);
  }
}
/**
 * Consolidates two labels of one category into one. Returns how many versions carried
 * the old name, so the caller can tell the admin what the merge actually touched rather
 * than reporting a silent success.
 */
export interface LabelUsage {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  /** Active versions in the label's category that carry it. */
  usedBy: number;
}

export interface DuplicatePair {
  categoryId: string;
  categoryName: string;
  a: LabelUsage;
  b: LabelUsage;
  /** Trigram similarity of the names, 0-1. */
  nameSimilarity: number;
  /** Jaccard overlap of the versions the two labels appear on, 0-1. */
  usageOverlap: number;
  reason: 'name' | 'usage';
}

export interface TaxonomySuggestions {
  duplicates: DuplicatePair[];
  unused: LabelUsage[];
}

/**
 * Hygiene suggestions for the label vocabulary, computed -- never applied. Two signals,
 * both within one category (a merge never crosses categories):
 *
 *  - names that are near-identical by trigram similarity ("Panduan" / "Panduan Teknis");
 *  - labels that ride on the same versions (Jaccard overlap of usage), which is what the
 *    mockup calls "kemiripan penggunaan".
 *
 * Plus labels no active version uses. RLS scopes everything to the actor's categories.
 */
export async function taxonomySuggestions(actorId: string): Promise<TaxonomySuggestions> {
  return withActor(actorId, async ({ client }) => {
    // Two sources on purpose: which labels exist is the caller's RLS view; how many
    // active versions carry each is a definer count (see migration 031), so a document
    // the caller cannot read still counts and its label is never called unused.
    const usage = await client.query<{
      id: string;
      category_id: string;
      category_name: string;
      name: string;
      used_by: string;
      versions: string[] | null;
    }>(
      `SELECT l.id,l.category_id,c.name AS category_name,l.name,
        coalesce(u.used_by,0) AS used_by,
        (SELECT array_agg(v.id::text) FROM app.document_versions v
          WHERE v.category_id=l.category_id AND l.name=ANY(v.labels) AND app.is_active_version(v.id)) AS versions
       FROM app.labels l
       JOIN app.categories c ON c.id=l.category_id
       LEFT JOIN app.label_usage_counts() u ON u.label_id=l.id
       WHERE l.merged_into IS NULL
       ORDER BY c.name,l.name`,
    );
    const rows = usage.rows.map((r) => ({
      id: r.id,
      categoryId: r.category_id,
      categoryName: r.category_name,
      name: r.name,
      usedBy: Number(r.used_by),
      // Overlap is computed over the versions the caller can see; it is a hint, and a
      // hidden version can only make two labels look less related, never more.
      versions: new Set(r.versions ?? []),
    }));
    const pairs = await client.query<{ a: string; b: string; sim: number }>(
      `SELECT a.id AS a,b.id AS b,similarity(lower(a.name),lower(b.name)) AS sim
       FROM app.labels a JOIN app.labels b ON b.category_id=a.category_id AND a.id<b.id
       WHERE a.merged_into IS NULL AND b.merged_into IS NULL
         AND similarity(lower(a.name),lower(b.name)) >= 0.45`,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const duplicates: DuplicatePair[] = [];
    const seen = new Set<string>();
    const push = (
      a: (typeof rows)[number],
      b: (typeof rows)[number],
      nameSimilarity: number,
      reason: DuplicatePair['reason'],
    ) => {
      const key = [a.id, b.id].sort().join(':');
      if (seen.has(key)) return;
      seen.add(key);
      const both = [...a.versions].filter((v) => b.versions.has(v)).length;
      const either = new Set([...a.versions, ...b.versions]).size;
      duplicates.push({
        categoryId: a.categoryId,
        categoryName: a.categoryName,
        a: {
          id: a.id,
          categoryId: a.categoryId,
          categoryName: a.categoryName,
          name: a.name,
          usedBy: a.usedBy,
        },
        b: {
          id: b.id,
          categoryId: b.categoryId,
          categoryName: b.categoryName,
          name: b.name,
          usedBy: b.usedBy,
        },
        nameSimilarity: Number(nameSimilarity.toFixed(2)),
        usageOverlap: either ? Number((both / either).toFixed(2)) : 0,
        reason,
      });
    };
    for (const p of pairs.rows) {
      const a = byId.get(p.a),
        b = byId.get(p.b);
      if (a && b) push(a, b, Number(p.sim), 'name');
    }
    // Usage overlap: only meaningful once both labels are actually in use.
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!,
          b = rows[j]!;
        if (a.categoryId !== b.categoryId || a.versions.size < 2 || b.versions.size < 2) continue;
        const both = [...a.versions].filter((v) => b.versions.has(v)).length;
        const either = new Set([...a.versions, ...b.versions]).size;
        if (either && both / either >= 0.75) push(a, b, 0, 'usage');
      }
    duplicates.sort(
      (x, y) => y.usageOverlap - x.usageOverlap || y.nameSimilarity - x.nameSimilarity,
    );
    return {
      duplicates: duplicates.slice(0, 20),
      unused: rows
        .filter((r) => r.usedBy === 0)
        .map((r) => ({
          id: r.id,
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          name: r.name,
          usedBy: 0,
        })),
    };
  });
}

export async function mergeLabels(
  actorId: string,
  source: string,
  target: string,
  revision: number,
): Promise<{ aliasedName: string; mergedName: string; affectedVersions: number }> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{
        aliased_name: string;
        merged_name: string;
        affected_versions: number;
      }>('SELECT aliased_name,merged_name,affected_versions FROM app.merge_labels($1,$2,$3)', [
        source,
        target,
        revision,
      ]);
      const row = rows[0]!;
      return {
        aliasedName: row.aliased_name,
        mergedName: row.merged_name,
        affectedVersions: Number(row.affected_versions),
      };
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

/**
 * The taxonomy as this actor may see it, for export. RLS decides which categories exist,
 * so an export can never describe a branch the actor has no scope over.
 */
export async function exportTaxonomy(actorId: string): Promise<{
  exportedAt: string;
  categories: Array<{
    id: string;
    parentId: string | null;
    name: string;
    minimumClassification: string;
    approvalSteps: number;
    labels: Array<{ name: string; color: string; usedBy: number; mergedInto: string | null }>;
  }>;
}> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      parent_id: string | null;
      name: string;
      minimum_classification: string;
      approval_steps: number;
      labels: Array<{
        name: string;
        color: string;
        usedBy: number;
        mergedInto: string | null;
      }> | null;
    }>(
      `SELECT c.id,c.parent_id,c.name,c.minimum_classification,c.approval_steps,
        (SELECT json_agg(json_build_object('name',l.name,'color',l.color,'usedBy',
          (SELECT count(*) FROM app.document_versions v WHERE v.category_id=c.id AND l.name=ANY(v.labels)),
          'mergedInto',(SELECT m.name FROM app.labels m WHERE m.id=l.merged_into))
          ORDER BY l.name)
         FROM app.labels l WHERE l.category_id=c.id) AS labels
       FROM app.categories c ORDER BY c.position,c.name`,
    );
    return {
      exportedAt: new Date().toISOString(),
      categories: rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        minimumClassification: r.minimum_classification,
        approvalSteps: r.approval_steps,
        labels: r.labels ?? [],
      })),
    };
  });
}

export async function assignUser(
  actorId: string,
  target: string,
  v: ReturnType<typeof parseAssignment>,
) {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query('SELECT app.assign_user($1,$2,$3,$4::uuid[])', [
        target,
        v.role,
        v.scopeAll,
        v.categoryIds,
      ]);
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
