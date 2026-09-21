import { randomUUID } from 'node:crypto';
import {
  effectiveCapabilities,
  hasCapability,
  isRole,
  type Actor,
  type Classification,
} from '@intradocs/core';
import type { CatalogQuery } from '@intradocs/core/validation';
import { withActor } from './index.ts';
export class AccessDenied extends Error {}
export type Category = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  icon: string;
  color: string;
  documentCount: number;
};
export type DocumentItem = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  categoryId: string;
  categoryName: string;
  classification: Classification;
  labels: string[];
  ownerLabel: string;
  ownerId: string;
  versionId: string;
  versionLabel: string;
  format: string;
  bytes: number;
  updatedAt: string;
  status:
    | 'published'
    | 'in_review'
    | 'draft'
    | 'withdrawn'
    | 'changes_requested'
    | 'rejected'
    | 'indexing'
    | 'failed'
    | 'superseded';
  expiresAt: string | null;
};
export type DocumentDetail = DocumentItem & {
  markdownKey: string;
  markdownHash: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewAt: string | null;
  expired: boolean;
};
type RawDocument = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category_id: string;
  category_name: string;
  classification: Classification;
  labels: string[];
  owner_label: string;
  owner_id: string;
  version_id: string;
  version_label: string;
  source_format: string;
  byte_size: number;
  created_at: Date;
  status: DocumentItem['status'];
  expires_at: Date | null;
  markdown_key: string;
  markdown_sha256: string;
  approved_by_label: string | null;
  approved_at: Date | null;
  review_at: Date | null;
  expired: boolean;
};
const fields = `d.id,d.slug,v.title,v.summary,v.category_id,c.name AS category_name,v.classification,v.labels,d.owner_label,d.owner_id,
 coalesce(v.expires_at<=now(),false) AS expired,v.id AS version_id,v.label AS version_label,v.source_format,v.byte_size,v.created_at,v.expires_at,v.markdown_key,v.markdown_sha256,v.approved_by_label,v.approved_at,v.review_at,
 CASE WHEN d.withdrawn THEN 'withdrawn' WHEN d.current_version_id=v.id THEN 'published' WHEN v.publication_state='superseded' THEN 'superseded' WHEN v.review_state='approved' THEN v.processing_state ELSE v.review_state END AS status`;
const from = `FROM app.documents d
 JOIN LATERAL (SELECT * FROM app.document_versions v0 WHERE v0.document_id=d.id
 ORDER BY (v0.id=d.current_version_id) DESC NULLS LAST,v0.version_number DESC LIMIT 1) v ON true
 JOIN app.categories c ON c.id=v.category_id`;
function mapDocument(r: RawDocument): DocumentDetail {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    categoryId: r.category_id,
    categoryName: r.category_name,
    classification: r.classification,
    labels: r.labels,
    ownerLabel: r.owner_label,
    ownerId: r.owner_id,
    versionId: r.version_id,
    versionLabel: r.version_label,
    format: r.source_format,
    bytes: r.byte_size,
    updatedAt: r.created_at.toISOString(),
    status: r.status,
    expiresAt: r.expires_at?.toISOString() ?? null,
    markdownKey: r.markdown_key,
    markdownHash: r.markdown_sha256,
    approvedBy: r.approved_by_label,
    approvedAt: r.approved_at?.toISOString() ?? null,
    reviewAt: r.review_at?.toISOString() ?? null,
    expired: r.expired,
  };
}
/** The person's own email switch (migration 041); read on the settings page. */
export async function emailNotificationsEnabled(actorId: string): Promise<boolean> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{ on: boolean }>(
      'SELECT email_notifications AS "on" FROM app.profiles WHERE id=app.actor_id()',
    );
    return rows[0]?.on ?? true;
  });
}
export async function setEmailNotifications(actorId: string, value: boolean): Promise<void> {
  await withActor(actorId, async ({ client }) => {
    await client.query('SELECT app.set_email_notifications($1)', [value]);
  });
}
export async function loadActor(id: string): Promise<Actor | null> {
  return withActor(id, async ({ client }) => {
    // The custom role's denials are read here, on every request, so a change to a
    // role definition reaches its holders at their next page -- no session to expire.
    const { rows } = await client.query<{
      id: string;
      name: string;
      email: string;
      unit: string;
      role: string;
      active: boolean;
      scope_all: boolean;
      custom_role_id: string | null;
      custom_role_name: string | null;
      denied: string[] | null;
    }>(
      `SELECT p.id,p.name,p.email,p.unit,p.role,p.active,p.scope_all,
              r.id AS custom_role_id,r.name AS custom_role_name,r.denied_capabilities AS denied
       FROM app.profiles p LEFT JOIN app.custom_roles r ON r.id=p.custom_role_id AND r.archived_at IS NULL AND r.base_role=p.role
       WHERE p.id=$1`,
      [id],
    );
    const p = rows[0];
    if (!p || !p.active || !isRole(p.role)) return null;
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      unit: p.unit,
      role: p.role,
      active: p.active,
      scopeAll: p.scope_all,
      customRole: p.custom_role_id ? { id: p.custom_role_id, name: p.custom_role_name! } : null,
      capabilities: effectiveCapabilities(p.role, p.denied ?? []),
    };
  });
}
export async function listCategories(actorId: string): Promise<Category[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      parent_id: string | null;
      name: string;
      description: string;
      icon: string;
      color: string;
      document_count: string;
    }>(`
   SELECT c.id,c.parent_id,c.name,c.description,c.icon,c.color,
    (SELECT count(*) FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id
     WHERE d.category_id=c.id AND app.is_active_version(v.id)) AS document_count
   FROM app.categories c ORDER BY c.position,c.name`);
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      color: r.color,
      documentCount: Number(r.document_count),
    }));
  });
}
export async function listDocuments(
  actorId: string,
  q: CatalogQuery,
): Promise<{ items: DocumentItem[]; total: number; pageSize: number }> {
  return withActor(actorId, async ({ client }) => {
    const source =
      q.status === 'mine'
        ? from.replace(
            '(v0.id=d.current_version_id) DESC NULLS LAST,v0.version_number DESC',
            'v0.version_number DESC',
          )
        : from;
    const where = `WHERE ($1='' OR position(lower($1) in lower(v.title||' '||v.summary))>0)
      AND ($2::uuid IS NULL OR v.category_id=$2::uuid)
      AND ($3='all' OR ($3='published' AND app.is_active_version(v.id)) OR ($3='mine' AND d.owner_id=app.actor_id() AND v.id IS DISTINCT FROM d.current_version_id))
      AND ($4::text IS NULL OR $4=ANY(v.labels)) AND ($5::text IS NULL OR v.source_format=$5)
      AND ($6::text IS NULL OR d.owner_id=$6) AND ($7::timestamptz IS NULL OR v.created_at>=$7)
      AND ($8::text IS NULL OR ($8='favorites' AND EXISTS(SELECT 1 FROM app.favorites f WHERE f.document_id=d.id AND f.user_id=app.actor_id())) OR ($8='history' AND EXISTS(SELECT 1 FROM app.read_history h WHERE h.version_id=v.id AND h.user_id=app.actor_id())))`;
    const values = [
        q.q,
        q.category,
        q.status,
        q.label ?? null,
        q.format ?? null,
        q.owner ?? null,
        q.after ?? null,
        q.view ?? null,
      ],
      pageSize = 8;
    const count = await client.query<{ total: string }>(
      `SELECT count(*) AS total ${source} ${where}`,
      values,
    );
    const ordering =
      q.view === 'history'
        ? '(SELECT last_read_at FROM app.read_history h WHERE h.version_id=v.id AND h.user_id=app.actor_id()) DESC'
        : q.sort === 'title'
          ? 'v.title ASC'
          : 'v.created_at DESC';
    const { rows } = await client.query<RawDocument>(
      `SELECT ${fields} ${source} ${where} ORDER BY ${ordering},d.id LIMIT $9 OFFSET $10`,
      [...values, pageSize, (q.page - 1) * pageSize],
    );
    const items = rows.map((r) => {
      const d = mapDocument(r);
      return {
        id: d.id,
        slug: d.slug,
        title: d.title,
        summary: d.summary,
        categoryId: d.categoryId,
        categoryName: d.categoryName,
        classification: d.classification,
        labels: d.labels,
        ownerLabel: d.ownerLabel,
        ownerId: d.ownerId,
        versionId: d.versionId,
        versionLabel: d.versionLabel,
        format: d.format,
        bytes: d.bytes,
        updatedAt: d.updatedAt,
        status: d.status,
        expiresAt: d.expiresAt,
      };
    });
    return { items, total: Number(count.rows[0]?.total ?? 0), pageSize };
  });
}
export async function readDocument(
  actorId: string,
  id: string,
  versionId?: string,
): Promise<DocumentDetail | null> {
  return withActor(actorId, async ({ client }) => {
    const source = from.replace(
      'WHERE v0.document_id=d.id',
      'WHERE v0.document_id=d.id AND ($2::uuid IS NULL OR v0.id=$2)',
    );
    const { rows } = await client.query<RawDocument>(`SELECT ${fields} ${source} WHERE d.id=$1`, [
      id,
      versionId ?? null,
    ]);
    if (!rows[0]) return null;
    await client.query(
      `INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.read',$1,$2)`,
      [id, randomUUID()],
    );
    await client.query(
      'INSERT INTO app.read_history(user_id,version_id) VALUES(app.actor_id(),$1) ON CONFLICT(user_id,version_id) DO UPDATE SET last_read_at=now(),reads=app.read_history.reads+1',
      [rows[0].version_id],
    );
    return mapDocument(rows[0]);
  });
}
export async function readVersionFile(
  actorId: string,
  id: string,
): Promise<{ documentId: string; key: string; hash: string } | null> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      document_id: string;
      markdown_key: string;
      markdown_sha256: string;
    }>(`SELECT document_id,markdown_key,markdown_sha256 FROM app.document_versions WHERE id=$1`, [
      id,
    ]);
    if (!rows[0]) return null;
    await client.query(
      `INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.download',$1,$2)`,
      [rows[0].document_id, randomUUID()],
    );
    return {
      documentId: rows[0].document_id,
      key: rows[0].markdown_key,
      hash: rows[0].markdown_sha256,
    };
  });
}
export type UserItem = Actor & {
  categories: string[];
  categoryIds: string[];
  customRoleId: string | null;
  customRoleName: string | null;
};
export async function listUsers(actor: Actor): Promise<UserItem[]> {
  if (!hasCapability(actor, 'users.view')) throw new AccessDenied();
  return withActor(actor.id, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      email: string;
      unit: string;
      role: Actor['role'];
      active: boolean;
      scope_all: boolean;
      categories: string[];
      category_ids: string[];
      custom_role_id: string | null;
      custom_role_name: string | null;
    }>(`
   SELECT p.*, ARRAY(SELECT category_id::text FROM app.category_grants WHERE user_id=p.id) AS category_ids, coalesce(ARRAY(SELECT c.name FROM app.category_grants g JOIN app.categories c ON c.id=g.category_id WHERE g.user_id=p.id ORDER BY c.name),'{}') AS categories,
          r.name AS custom_role_name
   FROM app.profiles p LEFT JOIN app.custom_roles r ON r.id=p.custom_role_id AND r.archived_at IS NULL
   ORDER BY p.name`);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      unit: p.unit,
      role: p.role,
      active: p.active,
      scopeAll: p.scope_all,
      categories: p.categories,
      categoryIds: p.category_ids,
      customRoleId: p.custom_role_id,
      customRoleName: p.custom_role_name,
    }));
  });
}
export async function setUserActive(actor: Actor, target: string, active: boolean): Promise<void> {
  if (!hasCapability(actor, 'users.manage') || target === actor.id)
    throw new AccessDenied('Perubahan akun sendiri ditolak.');
  await withActor(actor.id, async ({ client }) => {
    await client.query('SELECT pg_advisory_xact_lock(719281,1)');
    // Recheck after serialization; never trust an earlier session snapshot for a write.
    const now = await client.query<{ role: string; active: boolean }>(
      'SELECT role,active FROM app.profiles WHERE id=$1',
      [actor.id],
    );
    if (!now.rows[0]?.active || now.rows[0].role !== 'super_admin') throw new AccessDenied();
    const result = await client.query(
      'UPDATE app.profiles SET active=$1 WHERE id=$2 AND active IS DISTINCT FROM $1 RETURNING id',
      [active, target],
    );
    if (!result.rowCount) return;
    await client.query(
      `INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id) VALUES(app.actor_id(),$1,$2,$3)`,
      [active ? 'user.activated' : 'user.deactivated', target, randomUUID()],
    );
  });
}
/**
 * The audit rows of a date range for export: the same shielding as listAudit (names and
 * titles only where the exporter may see them), oldest first so the file reads as a
 * ledger, one row more than the limit so the caller knows it was cut. The export is
 * recorded as an audit event of its own in the same transaction.
 */
export async function exportAudit(
  actor: Actor,
  filter: { from: Date; to: Date; action: string | null },
  limit: number,
): Promise<{
  rows: Array<{
    id: string;
    createdAt: string;
    action: string;
    actorId: string;
    actorName: string | null;
    documentId: string | null;
    documentTitle: string | null;
    subjectUserId: string | null;
    subjectName: string | null;
  }>;
  truncated: boolean;
}> {
  if (!hasCapability(actor, 'audit.view')) throw new AccessDenied();
  return withActor(actor.id, async ({ client }) => {
    // The range can hold thousands of rows; resolving names and titles per row through
    // RLS is what made the page's query unfit here. The events come first (one policy
    // check per row), then the distinct people and documents they mention are looked up
    // once each -- the same shielding, a few dozen checks instead of thousands.
    const { rows } = await client.query<{
      id: string;
      action: string;
      actor_id: string;
      document_id: string | null;
      subject_user_id: string | null;
      created_at: Date;
    }>(
      `SELECT a.request_id::text AS id,a.action,a.actor_id,a.created_at,a.document_id,a.subject_user_id
       FROM app.audit_events a
       WHERE a.created_at>=$1 AND a.created_at<=$2 AND ($3::text IS NULL OR a.action=$3)
       ORDER BY a.id ASC LIMIT $4`,
      [filter.from, filter.to, filter.action, limit + 1],
    );
    const truncated = rows.length > limit;
    const page = rows.slice(0, limit);
    const people = [...new Set(page.flatMap((r) => [r.actor_id, r.subject_user_id ?? '']))].filter(
      Boolean,
    );
    const documents = [...new Set(page.map((r) => r.document_id ?? ''))].filter(Boolean);
    const names = new Map<string, string>();
    const titles = new Map<string, string>();
    if (people.length)
      for (const p of (
        await client.query<{ id: string; name: string }>(
          'SELECT id,name FROM app.profiles WHERE id=ANY($1)',
          [people],
        )
      ).rows)
        names.set(p.id, p.name);
    if (documents.length)
      for (const d of (
        await client.query<{ id: string; title: string }>(
          'SELECT id,title FROM app.documents WHERE id=ANY($1::uuid[])',
          [documents],
        )
      ).rows)
        titles.set(d.id, d.title);
    await client.query(
      `INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'audit.exported',$1)`,
      [randomUUID()],
    );
    return {
      truncated,
      rows: page.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        action: r.action,
        actorId: r.actor_id,
        actorName: names.get(r.actor_id) ?? null,
        documentId: r.document_id,
        documentTitle: r.document_id ? (titles.get(r.document_id) ?? null) : null,
        subjectUserId: r.subject_user_id,
        subjectName: r.subject_user_id ? (names.get(r.subject_user_id) ?? null) : null,
      })),
    };
  });
}
export async function listAudit(
  actor: Actor,
  filter?: { from: Date; to: Date; action: string | null },
): Promise<
  Array<{
    id: string;
    action: string;
    actorId: string;
    /** Name when the actor may see that profile; otherwise null and the UI shows a placeholder. */
    actorName: string | null;
    /** Document title when the actor may read it; RLS on documents decides. */
    documentTitle: string | null;
    documentHref: string | null;
    subjectName: string | null;
    createdAt: string;
  }>
> {
  if (!hasCapability(actor, 'audit.view')) throw new AccessDenied();
  return withActor(actor.id, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      action: string;
      actor_id: string;
      actor_name: string | null;
      document_id: string | null;
      document_title: string | null;
      document_slug: string | null;
      subject_name: string | null;
      created_at: Date;
    }>(
      `SELECT a.request_id::text AS id,a.action,a.actor_id,a.created_at,
        (SELECT p.name FROM app.profiles p WHERE p.id=a.actor_id) AS actor_name,
        a.document_id,
        (SELECT d.title FROM app.documents d WHERE d.id=a.document_id) AS document_title,
        (SELECT d.slug FROM app.documents d WHERE d.id=a.document_id) AS document_slug,
        (SELECT p.name FROM app.profiles p WHERE p.id=a.subject_user_id) AS subject_name
       FROM app.audit_events a
       WHERE ($1::timestamptz IS NULL OR a.created_at>=$1) AND ($2::timestamptz IS NULL OR a.created_at<=$2)
         AND ($3::text IS NULL OR a.action=$3)
       ORDER BY a.id DESC LIMIT 100`,
      [filter?.from ?? null, filter?.to ?? null, filter?.action ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actor_id,
      actorName: r.actor_name,
      documentTitle: r.document_title,
      documentHref:
        r.document_id && r.document_slug ? `/dokumen/${r.document_id}/${r.document_slug}` : null,
      subjectName: r.subject_name,
      createdAt: r.created_at.toISOString(),
    }));
  });
}
