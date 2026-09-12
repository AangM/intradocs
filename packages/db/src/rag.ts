import { randomUUID } from 'node:crypto';
import type { AllowedSource, RetrievalScope } from '@intradocs/core/rag';
import { withActor } from './index.ts';

/**
 * Retrieval-side database access.
 *
 * Every query here runs as intradocs_app inside withActor(), so the RLS policy
 * `rag_entries_read USING(app.is_active_version(version_id))` decides what exists for
 * this actor. Nothing in this file re-implements that rule: a version that was revoked,
 * expired, superseded or withdrawn simply returns no rows, and a caller cannot widen
 * the result by passing a different argument.
 */

/**
 * The knowledge IDs this actor may search, and the metadata needed to turn a hit into a
 * citation. The scope cap is applied in SQL so a large corpus cannot be used to make one
 * request unbounded; ordering is stable so the cap is deterministic rather than arbitrary.
 */
export async function listAuthorizedSources(
  actorId: string,
  limit: number,
  scope: RetrievalScope = { type: 'all' },
): Promise<AllowedSource[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new Error('Batas scope tidak valid.');
  // A narrower scope is an extra WHERE on the same RLS-filtered rows. A category or
  // document the actor cannot see matches nothing, which is indistinguishable from an
  // empty category -- the request abstains and learns nothing.
  const categoryId = scope.type === 'category' ? scope.categoryId : null;
  const documentIds = scope.type === 'documents' ? scope.documentIds : null;
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      knowledge_id: string;
      document_id: string;
      version_id: string;
      slug: string;
      title: string;
      label: string;
      classification: string;
      category_name: string;
    }>(
      `SELECT e.knowledge_id,e.document_id,e.version_id,d.slug,v.title,v.label,v.classification,
        coalesce(c.name,'-') AS category_name
       FROM app.rag_index_entries e
       JOIN app.document_versions v ON v.id=e.version_id
       JOIN app.documents d ON d.id=e.document_id
       LEFT JOIN app.categories c ON c.id=v.category_id
       WHERE ($2::uuid IS NULL OR v.category_id IN (
           WITH RECURSIVE sub AS (SELECT id FROM app.categories WHERE id=$2
             UNION ALL SELECT c2.id FROM app.categories c2 JOIN sub ON c2.parent_id=sub.id)
           SELECT id FROM sub))
         AND ($3::uuid[] IS NULL OR e.document_id=ANY($3))
       ORDER BY e.exported_at DESC,e.version_id
       LIMIT $1`,
      [limit, categoryId, documentIds],
    );
    return rows.map((r) => ({
      knowledgeId: r.knowledge_id,
      documentId: r.document_id,
      versionId: r.version_id,
      documentSlug: r.slug,
      documentTitle: r.title,
      versionLabel: r.label,
      classification: r.classification,
      categoryName: r.category_name,
    }));
  });
}

/**
 * Re-reads the sources behind a set of knowledge IDs after retrieval has returned.
 *
 * This is the second check, not a repeat of the first: permissions may have changed
 * between building the query scope and receiving hits, and a hit for an ID that was
 * never in scope must not be answerable either. Only IDs that still satisfy
 * is_active_version for this actor come back.
 */
export async function resolveAuthorizedSources(
  actorId: string,
  knowledgeIds: readonly string[],
): Promise<Map<string, AllowedSource>> {
  const unique = [...new Set(knowledgeIds)].filter(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 200,
  );
  if (unique.length === 0) return new Map();
  const sources = await withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      knowledge_id: string;
      document_id: string;
      version_id: string;
      slug: string;
      title: string;
      label: string;
      classification: string;
      category_name: string;
    }>(
      `SELECT e.knowledge_id,e.document_id,e.version_id,d.slug,v.title,v.label,v.classification,
        coalesce(c.name,'-') AS category_name
       FROM app.rag_index_entries e
       JOIN app.document_versions v ON v.id=e.version_id
       JOIN app.documents d ON d.id=e.document_id
       LEFT JOIN app.categories c ON c.id=v.category_id
       WHERE e.knowledge_id = ANY($1::text[])`,
      [unique],
    );
    return rows;
  });
  return new Map(
    sources.map((r) => [
      r.knowledge_id,
      {
        knowledgeId: r.knowledge_id,
        documentId: r.document_id,
        versionId: r.version_id,
        documentSlug: r.slug,
        documentTitle: r.title,
        versionLabel: r.label,
        classification: r.classification,
        categoryName: r.category_name,
      },
    ]),
  );
}

/**
 * Authorised Markdown for the versions actually cited, used only to resolve a heading
 * anchor so a citation opens at the right place. Read through the same RLS, so a
 * locator can never be produced for a document the actor may not read.
 */
export async function readAuthorizedMarkdownKeys(
  actorId: string,
  versionIds: readonly string[],
): Promise<Array<{ versionId: string; key: string; hash: string }>> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return [];
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{ id: string; markdown_key: string; sha: string }>(
      `SELECT v.id,v.markdown_key,v.markdown_sha256 AS sha FROM app.document_versions v
       JOIN app.rag_index_entries e ON e.version_id=v.id
       WHERE v.id = ANY($1::uuid[])`,
      [unique],
    );
    return rows.map((r) => ({ versionId: r.id, key: r.markdown_key, hash: r.sha }));
  });
}

export type RagAuditAction =
  'rag.retrieval' | 'rag.chat' | 'rag.citation_rejected' | 'rag.abstained';

/**
 * Records one RAG action. The question, the answer and any snippet stay out of the audit
 * row on purpose: the table is readable by admins under RLS, and prompts can themselves
 * carry sensitive content. Only actor, action, document and request ID are kept.
 */
export async function recordRagAudit(
  actorId: string,
  action: RagAuditAction,
  documentIds: readonly string[] = [],
  requestId: string = randomUUID(),
): Promise<void> {
  const targets = [...new Set(documentIds)].slice(0, 20);
  await withActor(actorId, async ({ client }) => {
    if (targets.length === 0) {
      await client.query(
        `INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),$1,$2)`,
        [action, requestId],
      );
      return;
    }
    await client.query(
      `INSERT INTO app.audit_events(actor_id,action,document_id,request_id)
       SELECT app.actor_id(),$1,d,$2 FROM unnest($3::uuid[]) AS d`,
      [action, requestId, targets],
    );
  });
}
