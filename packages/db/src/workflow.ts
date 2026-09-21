import { randomUUID } from 'node:crypto';
import { withActor } from './index.ts';
import { WorkflowError, findSensitiveContent, type Decision } from '@intradocs/core/workflow';
export function translateWorkflowError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (['P0002', '42501'].includes(code ?? ''))
    throw new WorkflowError('Dokumen atau pengajuan tidak tersedia.', 404);
  if (['40001', '23505'].includes(code ?? ''))
    throw new WorkflowError('Data sudah berubah atau permintaan telah diproses. Muat ulang.');
  if (['23514', '23503', '22P02'].includes(code ?? ''))
    throw new WorkflowError(
      'Prasyarat belum terpenuhi. Periksa versi, reviewer, temuan, tanggal, atau referensi taksonomi.',
      422,
    );
  throw error;
}
export type VersionSummary = {
  id: string;
  documentId: string;
  label: string;
  title: string;
  summary: string;
  labels: string[];
  categoryId: string;
  classification: string;
  reviewState: string;
  processingState: string;
  publicationState: string;
  createdAt: string;
  active: boolean;
  authorId: string;
};
export async function versionSummaries(
  actorId: string,
  documentId: string,
): Promise<VersionSummary[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query(
      'SELECT v.*,d.current_version_id FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE d.id=$1 ORDER BY v.version_number DESC LIMIT 50',
      [documentId],
    );
    return rows.map((v) => ({
      id: v.id,
      documentId: v.document_id,
      label: v.label,
      title: v.title,
      summary: v.summary,
      labels: v.labels,
      categoryId: v.category_id,
      classification: v.classification,
      reviewState: v.review_state,
      processingState: v.processing_state,
      publicationState: v.publication_state,
      createdAt: v.created_at.toISOString(),
      active: v.id === v.current_version_id,
      authorId: v.author_id,
    }));
  });
}
export type ReviewInfo = {
  requiredSteps: number;
  requestId: string | null;
  state: string;
  candidates: { id: string; name: string; role: string }[];
  steps: {
    stage: number;
    reviewerId: string;
    /** Null when the profile is outside the actor's view (RLS); show the stage instead. */
    reviewerName: string | null;
    decision: string | null;
    reason: string;
    decidedAt: string | null;
  }[];
  findings: {
    fingerprint: string;
    rule: string;
    severity: string;
    line: number;
    resolved: boolean;
    justification: string | null;
  }[];
  outbox: { state: string; attempts: number; errorCode: string | null } | null;
};
export async function reviewInfo(actorId: string, versionId: string): Promise<ReviewInfo | null> {
  return withActor(actorId, async ({ client: c }) => {
    const v = (
      await c.query(
        'SELECT v.*,d.owner_id FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=$1',
        [versionId],
      )
    ).rows[0];
    if (!v) return null;
    const r = (
      await c.query('SELECT * FROM app.approval_requests WHERE version_id=$1', [versionId])
    ).rows[0];
    const required = (await c.query<{ n: number }>('SELECT app.rule_steps($1) AS n', [versionId]))
      .rows[0]!.n;
    const candidates =
      v.owner_id === actorId && v.review_state === 'draft'
        ? (
            await c.query<{ id: string; name: string; role: string }>(
              'SELECT * FROM app.review_candidates($1)',
              [versionId],
            )
          ).rows
        : [];
    const steps = r
      ? (
          await c.query(
            'SELECT s.*,(SELECT p.name FROM app.profiles p WHERE p.id=s.reviewer_id) AS reviewer_name FROM app.approval_steps s WHERE s.request_id=$1 ORDER BY s.stage',
            [r.id],
          )
        ).rows
      : [];
    const findings = (
      await c.query(
        'SELECT * FROM app.version_findings WHERE version_id=$1 ORDER BY source_line,rule',
        [versionId],
      )
    ).rows;
    const job = (
      await c.query(
        'SELECT state,attempts,error_code FROM app.publication_outbox WHERE version_id=$1',
        [versionId],
      )
    ).rows[0];
    return {
      requiredSteps: r?.required_steps ?? required,
      requestId: r?.id ?? null,
      state: r?.state ?? v.review_state,
      candidates,
      steps: steps.map((s) => ({
        stage: s.stage,
        reviewerId: s.reviewer_id,
        reviewerName: s.reviewer_name ?? null,
        decision: s.decision,
        reason: s.reason,
        decidedAt: s.decided_at?.toISOString() ?? null,
      })),
      findings: findings.map((f) => ({
        fingerprint: f.fingerprint,
        rule: f.rule,
        severity: f.severity,
        line: f.source_line,
        resolved: !!f.resolved_at,
        justification: f.justification,
      })),
      outbox: job ? { state: job.state, attempts: job.attempts, errorCode: job.error_code } : null,
    };
  });
}
async function mutate(actorId: string, sql: string, values: unknown[]) {
  try {
    return await withActor(actorId, async ({ client }) => client.query(sql, values));
  } catch (e) {
    translateWorkflowError(e);
  }
}
export async function submitVersion(
  actorId: string,
  v: { versionId: string; reviewers: string[]; reviewAt: string | null; expiresAt: string | null },
  markdown: string,
) {
  return (
    await mutate(
      actorId,
      'SELECT app.submit_version($1,$2::text[],$3::timestamptz,$4::timestamptz,$5,$6::jsonb) AS id',
      [
        v.versionId,
        v.reviewers,
        v.reviewAt,
        v.expiresAt,
        markdown,
        JSON.stringify(findSensitiveContent(markdown)),
      ],
    )
  ).rows[0].id as string;
}
export async function decideVersion(
  actorId: string,
  v: { versionId: string; decision: Decision; reason: string },
) {
  return (
    await mutate(actorId, 'SELECT app.decide_version($1,$2,$3) AS state', [
      v.versionId,
      v.decision,
      v.reason,
    ])
  ).rows[0].state as string;
}
export async function resolveFinding(
  actorId: string,
  vid: string,
  fingerprint: string,
  reason: string,
) {
  await mutate(actorId, 'SELECT app.resolve_finding($1,$2,$3)', [vid, fingerprint, reason]);
}
export async function retryPublication(actorId: string, vid: string) {
  await mutate(actorId, 'SELECT app.retry_publication($1)', [vid]);
}
/**
 * The owner confirms the current published version is still valid: the review date
 * moves forward by the category's cadence (never past the expiry). Returns the new date.
 */
export async function reaffirmVersion(actorId: string, versionId: string): Promise<string> {
  const r = await mutate(actorId, 'SELECT app.reaffirm_version($1) AS review_at', [versionId]);
  return (r.rows[0].review_at as Date).toISOString();
}
export type RetentionState = 'soon' | 'due' | 'overdue' | 'expired';
export interface RetentionRow {
  state: RetentionState;
  documentId: string;
  slug: string;
  title: string;
  ownerLabel: string;
  categoryName: string;
  reviewAt: string | null;
  expiresAt: string | null;
  /** When the policy acts: the review date, or expiry + grace for an expired one. */
  dueAt: string;
}
/** Administrators' view of what retention will do next, within their scope. */
export async function retentionOverview(
  actorId: string,
  windows: { graceDays: number; overdueDays: number },
): Promise<RetentionRow[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query('SELECT * FROM app.retention_overview($1,$2)', [
      windows.graceDays,
      windows.overdueDays,
    ]);
    return rows.map((r) => ({
      state: r.state as RetentionState,
      documentId: r.document_id as string,
      slug: r.slug as string,
      title: r.title as string,
      ownerLabel: r.owner_label as string,
      categoryName: r.category_name as string,
      reviewAt: r.review_at?.toISOString() ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
      dueAt: (r.due_at as Date).toISOString(),
    }));
  });
}
export async function withdrawDocument(actorId: string, id: string, reason: string) {
  await mutate(actorId, 'SELECT app.withdraw_document($1,$2)', [id, reason]);
}
export type ApprovalQueueItem = {
  versionId: string;
  documentId: string;
  title: string;
  slug: string;
  ownerLabel: string;
  stage: number;
  requiredSteps: number;
  submittedAt: string;
  versionLabel: string;
  format: string;
  classification: string;
  labels: string[];
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  /** Security findings still waiting for a justification: what a reviewer must look at first. */
  openFindings: number;
  attachments: number;
};
export async function approvalQueue(actorId: string): Promise<ApprovalQueueItem[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query(
      `SELECT v.id AS version_id,d.id AS document_id,v.title,d.slug,d.owner_label,s.stage,r.required_steps,r.submitted_at,
              v.label AS version_label,v.source_format,v.classification,v.labels,v.category_id,c.name AS category_name,c.color AS category_color,
              (SELECT count(*) FROM app.version_findings f WHERE f.version_id=v.id AND f.resolved_at IS NULL)::int AS open_findings,
              (SELECT count(*) FROM app.version_attachments a WHERE a.version_id=v.id)::int AS attachments
         FROM app.approval_requests r
         JOIN app.approval_steps s ON s.request_id=r.id
         JOIN app.document_versions v ON v.id=r.version_id
         JOIN app.documents d ON d.id=v.document_id
         JOIN app.categories c ON c.id=v.category_id
        WHERE r.state='pending' AND s.reviewer_id=app.actor_id() AND s.decision IS NULL
        ORDER BY r.submitted_at LIMIT 100`,
    );
    return rows.map((r) => ({
      versionId: r.version_id as string,
      documentId: r.document_id as string,
      title: r.title as string,
      slug: r.slug as string,
      ownerLabel: r.owner_label as string,
      stage: r.stage as number,
      requiredSteps: r.required_steps as number,
      submittedAt: r.submitted_at.toISOString() as string,
      versionLabel: r.version_label as string,
      format: r.source_format as string,
      classification: r.classification as string,
      labels: (r.labels ?? []) as string[],
      categoryId: r.category_id as string,
      categoryName: r.category_name as string,
      categoryColor: r.category_color as string,
      openFindings: r.open_findings as number,
      attachments: r.attachments as number,
    }));
  });
}
/**
 * The three numbers the sidebar shows next to a link (mockup S03/S06): unread
 * notifications, submissions waiting for this reviewer, and the actor's own drafts.
 * Each is one count under RLS; nothing here names a document.
 */
export async function sidebarCounts(
  actorId: string,
): Promise<{ notifications: number; approvals: number; drafts: number }> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      notifications: number;
      approvals: number;
      drafts: number;
    }>(
      `SELECT (SELECT count(*) FROM app.notifications n WHERE n.user_id=app.actor_id() AND n.read_at IS NULL)::int AS notifications,
              (SELECT count(*) FROM app.approval_requests r JOIN app.approval_steps s ON s.request_id=r.id WHERE r.state='pending' AND s.reviewer_id=app.actor_id() AND s.decision IS NULL)::int AS approvals,
              (SELECT count(*) FROM app.documents d JOIN LATERAL(SELECT review_state FROM app.document_versions v0 WHERE v0.document_id=d.id ORDER BY v0.version_number DESC LIMIT 1) v ON true WHERE d.owner_id=app.actor_id() AND v.review_state IN ('draft','changes_requested'))::int AS drafts`,
    );
    return rows[0] ?? { notifications: 0, approvals: 0, drafts: 0 };
  });
}
export async function setFavorite(actorId: string, id: string, value: boolean) {
  await withActor(actorId, async ({ client }) => {
    if (
      !(
        await client.query(
          'SELECT id FROM app.documents WHERE id=$1 AND app.is_active_version(current_version_id)',
          [id],
        )
      ).rowCount
    )
      throw new WorkflowError('Dokumen tidak tersedia.', 404);
    if (value)
      await client.query(
        'INSERT INTO app.favorites(user_id,document_id) VALUES(app.actor_id(),$1) ON CONFLICT DO NOTHING',
        [id],
      );
    else
      await client.query(
        'DELETE FROM app.favorites WHERE user_id=app.actor_id() AND document_id=$1',
        [id],
      );
  });
}
export async function saveFeedback(
  actorId: string,
  v: { versionId: string; helpful: boolean; comment: string },
) {
  await withActor(actorId, async ({ client }) => {
    const row = (
      await client.query<{ document_id: string }>(
        'SELECT document_id FROM app.document_versions WHERE id=$1 AND app.is_active_version(id)',
        [v.versionId],
      )
    ).rows[0];
    if (!row) throw new WorkflowError('Dokumen tidak tersedia.', 404);
    await client.query(
      'INSERT INTO app.document_feedback(user_id,version_id,helpful,comment) VALUES(app.actor_id(),$1,$2,$3) ON CONFLICT(user_id,version_id) DO UPDATE SET helpful=excluded.helpful,comment=excluded.comment,created_at=now()',
      [v.versionId, v.helpful, v.comment],
    );
    await client.query(
      "INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.feedback',$1,$2)",
      [row.document_id, randomUUID()],
    );
  });
}
export async function readerPreferences(actorId: string, id: string, vid: string) {
  return withActor(actorId, async ({ client }) => ({
    favorite: !!(
      await client.query(
        'SELECT 1 FROM app.favorites WHERE user_id=app.actor_id() AND document_id=$1',
        [id],
      )
    ).rowCount,
    feedback:
      (
        await client.query<{ helpful: boolean; comment: string }>(
          'SELECT helpful,comment FROM app.document_feedback WHERE user_id=app.actor_id() AND version_id=$1',
          [vid],
        )
      ).rows[0] ?? null,
  }));
}
export async function listNotifications(actorId: string, limit = 100) {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query(
      'SELECT n.*,v.title,d.id AS document_id,d.slug FROM app.notifications n JOIN app.document_versions v ON v.id=n.version_id JOIN app.documents d ON d.id=v.document_id WHERE n.user_id=app.actor_id() ORDER BY n.created_at DESC LIMIT $1',
      [Math.min(Math.max(1, Math.trunc(limit)), 100)],
    );
    return rows.map((n) => ({
      id: n.id as string,
      kind: n.kind as string,
      read: !!n.read_at,
      createdAt: n.created_at.toISOString() as string,
      versionId: n.version_id as string,
      title: n.title as string,
      documentId: n.document_id as string,
      slug: n.slug as string,
    }));
  });
}
export async function markNotificationRead(actorId: string, id: string) {
  await withActor(actorId, async ({ client }) => {
    if (
      !(
        await client.query(
          'UPDATE app.notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=app.actor_id() RETURNING id',
          [id],
        )
      ).rowCount
    )
      throw new WorkflowError('Notifikasi tidak tersedia.', 404);
  });
}
/** Every unread notification of the actor becomes read now; returns how many changed. */
export async function markAllNotificationsRead(actorId: string): Promise<number> {
  return withActor(actorId, async ({ client }) => {
    const r = await client.query(
      'UPDATE app.notifications SET read_at=now() WHERE user_id=app.actor_id() AND read_at IS NULL',
    );
    return r.rowCount ?? 0;
  });
}
export async function ownerFeedback(actorId: string) {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query(
      'SELECT f.*,v.title,d.id AS document_id,d.slug FROM app.document_feedback f JOIN app.document_versions v ON v.id=f.version_id JOIN app.documents d ON d.id=v.document_id WHERE d.owner_id=app.actor_id() ORDER BY f.created_at DESC LIMIT 100',
    );
    return rows.map((f) => ({
      id: f.id as string,
      helpful: f.helpful as boolean,
      comment: f.comment as string,
      createdAt: f.created_at.toISOString() as string,
      versionId: f.version_id as string,
      title: f.title as string,
      documentId: f.document_id as string,
      slug: f.slug as string,
    }));
  });
}

export async function documentAccessCandidates(actorId: string, documentId: string) {
  return withActor(
    actorId,
    async ({ client }) =>
      (
        await client.query<{ id: string; name: string; role: string; granted: boolean }>(
          'SELECT * FROM app.document_access_candidates($1)',
          [documentId],
        )
      ).rows,
  );
}
export async function setDocumentAccess(
  actorId: string,
  documentId: string,
  member: string,
  grant: boolean,
) {
  await mutate(actorId, 'SELECT app.set_document_access($1,$2,$3)', [documentId, member, grant]);
}

/**
 * Withdraws a batch in one transaction. Returns how many were withdrawn so the caller can
 * report a number rather than a bare success.
 */
export async function withdrawDocuments(
  actorId: string,
  documentIds: readonly string[],
  reason: string,
): Promise<{ withdrawn: number }> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ withdrawn: number }>(
        'SELECT withdrawn FROM app.withdraw_documents($1::uuid[],$2)',
        [documentIds, reason],
      );
      return { withdrawn: Number(rows[0]!.withdrawn) };
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
