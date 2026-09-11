import { withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';

/**
 * Required reading.
 *
 * Every query runs under the actor's own RLS. A requirement is visible only to people who
 * can already read the document it points at, so being asked to read something never
 * reveals that it exists.
 */

export interface ReadingRequirement {
  id: string;
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  categoryName: string;
  note: string;
  dueAt: string | null;
  /** Decided by the database clock, so pages can render it without reading the time. */
  overdue: boolean;
  acknowledgedAt: string | null;
  versionId: string;
}

/** What this actor still has to read, plus what they have already acknowledged. */
export async function myRequiredReading(actorId: string): Promise<ReadingRequirement[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      document_id: string;
      slug: string;
      title: string;
      category_name: string;
      note: string;
      due_at: Date | null;
      overdue: boolean;
      acknowledged_at: Date | null;
      version_id: string;
    }>(
      `SELECT r.id,r.document_id,d.slug,v.title,c.name AS category_name,r.note,r.due_at,
        (r.due_at IS NOT NULL AND r.due_at<now() AND a.acknowledged_at IS NULL) AS overdue,
        a.acknowledged_at,d.current_version_id AS version_id
       FROM app.reading_requirements r
       JOIN app.documents d ON d.id=r.document_id
       JOIN app.document_versions v ON v.id=d.current_version_id
       JOIN app.categories c ON c.id=r.category_id
       LEFT JOIN app.reading_acknowledgements a ON a.requirement_id=r.id AND a.user_id=app.actor_id()
       ORDER BY (a.acknowledged_at IS NULL) DESC, r.due_at NULLS LAST, r.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      documentSlug: r.slug,
      documentTitle: r.title,
      categoryName: r.category_name,
      note: r.note,
      dueAt: r.due_at?.toISOString() ?? null,
      overdue: r.overdue,
      acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
      versionId: r.version_id,
    }));
  });
}

export async function createRequirement(
  actorId: string,
  input: { documentId: string; categoryId: string; note: string; dueAt: string | null },
): Promise<{ id: string }> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.reading_requirements(document_id,category_id,created_by,note,due_at)
         VALUES($1,$2,app.actor_id(),$3,$4) RETURNING id`,
        [input.documentId, input.categoryId, input.note, input.dueAt],
      );
      return { id: rows[0]!.id };
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

/**
 * Records that this person says they read it, against the version that is active right
 * now. Acknowledging a version that is no longer retrievable is refused by RLS, so an
 * acknowledgement always names something that was actually readable at the time.
 */
export async function acknowledgeReading(
  actorId: string,
  requirementId: string,
  versionId: string,
): Promise<void> {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query(
        `INSERT INTO app.reading_acknowledgements(requirement_id,user_id,version_id)
         VALUES($1,app.actor_id(),$2) ON CONFLICT DO NOTHING`,
        [requirementId, versionId],
      );
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
