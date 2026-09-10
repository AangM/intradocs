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
