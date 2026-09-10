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
