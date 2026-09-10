import { randomUUID } from 'node:crypto';
import { withActor } from './index.ts';

/**
 * Version comparison support.
 *
 * Both sides are read through the actor's own RLS, so a version this actor may not read
 * simply does not exist here. The pair is also required to belong to one document: a diff
 * across two documents would be a way to place text the reader may see beside text they
 * may not, and the join below makes that impossible rather than merely discouraged.
 */

export interface VersionForDiff {
  id: string;
  documentId: string;
  label: string;
  title: string;
  versionNumber: number;
  reviewState: string;
  publicationState: string;
  createdAt: string;
  markdownKey: string;
  markdownSha256: string;
  active: boolean;
}

export async function readVersionPair(
  actorId: string,
  documentId: string,
  leftId: string,
  rightId: string,
): Promise<{ left: VersionForDiff; right: VersionForDiff } | null> {
  if (leftId === rightId) return null;
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      document_id: string;
      label: string;
      title: string;
      version_number: number;
      review_state: string;
      publication_state: string;
      created_at: Date;
      markdown_key: string;
      markdown_sha256: string;
      current_version_id: string | null;
    }>(
      `SELECT v.id,v.document_id,v.label,v.title,v.version_number,v.review_state,
        v.publication_state,v.created_at,v.markdown_key,v.markdown_sha256,d.current_version_id
       FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
       WHERE v.document_id=$1 AND v.id = ANY($2::uuid[])`,
      [documentId, [leftId, rightId]],
    );
    // Anything less than both rows means one side was unreadable, belongs to another
    // document, or does not exist. All three are the same answer to the caller.
    if (rows.length !== 2) return null;
    const map = (r: (typeof rows)[number]): VersionForDiff => ({
      id: r.id,
      documentId: r.document_id,
      label: r.label,
      title: r.title,
      versionNumber: r.version_number,
      reviewState: r.review_state,
      publicationState: r.publication_state,
      createdAt: r.created_at.toISOString(),
      markdownKey: r.markdown_key,
      markdownSha256: r.markdown_sha256,
      active: r.id === r.current_version_id,
    });
    const left = rows.find((r) => r.id === leftId);
    const right = rows.find((r) => r.id === rightId);
    if (!left || !right) return null;
    return { left: map(left), right: map(right) };
  });
}

/** Versions this actor may compare, newest first. */
export async function comparableVersions(
  actorId: string,
  documentId: string,
): Promise<Array<Pick<VersionForDiff, 'id' | 'label' | 'versionNumber' | 'createdAt' | 'active'>>> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      label: string;
      version_number: number;
      created_at: Date;
      current_version_id: string | null;
    }>(
      `SELECT v.id,v.label,v.version_number,v.created_at,d.current_version_id
       FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
       WHERE v.document_id=$1 ORDER BY v.version_number DESC LIMIT 50`,
      [documentId],
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      versionNumber: r.version_number,
      createdAt: r.created_at.toISOString(),
      active: r.id === r.current_version_id,
    }));
  });
}

export class RollbackError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface SourceArtifacts {
  documentId: string;
  sourceFormat: string;
  markdownKey: string;
  markdownSha256: string;
  originalKey: string;
  originalSha256: string;
  provenanceKey: string;
  provenanceSha256: string;
}

/** The stored artifacts behind one version, read under the actor's own RLS. */
export async function readSourceArtifacts(
  actorId: string,
  documentId: string,
  versionId: string,
): Promise<SourceArtifacts | null> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      document_id: string;
      source_format: string;
      markdown_key: string;
      markdown_sha256: string;
      original_key: string;
      original_sha256: string;
      provenance_key: string;
      provenance_sha256: string;
    }>(
      `SELECT v.document_id,s.source_format,v.markdown_key,v.markdown_sha256,
        s.original_key,s.original_sha256,s.provenance_key,s.provenance_sha256
       FROM app.document_versions v JOIN app.version_sources s ON s.version_id=v.id
       WHERE v.id=$1 AND v.document_id=$2`,
      [versionId, documentId],
    );
    const r = rows[0];
    return r
      ? {
          documentId: r.document_id,
          sourceFormat: r.source_format,
          markdownKey: r.markdown_key,
          markdownSha256: r.markdown_sha256,
          originalKey: r.original_key,
          originalSha256: r.original_sha256,
          provenanceKey: r.provenance_key,
          provenanceSha256: r.provenance_sha256,
        }
      : null;
  });
}

/**
 * Records the restored draft once its artifacts have been copied.
 *
 * The copy happens before this call, and the function verifies it: the hashes it stores
 * come from the source version, and the keys must match the per-version naming pattern,
 * so a draft whose bytes differ from the version it claims to restore cannot be created.
 */
export async function recordRollback(
  actorId: string,
  input: {
    documentId: string;
    sourceVersionId: string;
    newVersionId: string;
    markdownKey: string;
    originalKey: string;
    provenanceKey: string;
    requestId?: string;
  },
): Promise<{ versionId: string; label: string }> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{ version_id: string; label: string }>(
      'SELECT version_id,label FROM app.rollback_version($1,$2,$3,$4,$5,$6,$7)',
      [
        input.sourceVersionId,
        input.newVersionId,
        input.documentId,
        input.requestId ?? randomUUID(),
        input.markdownKey,
        input.originalKey,
        input.provenanceKey,
      ],
    );
    const row = rows[0];
    if (!row) throw new RollbackError('Pemulihan versi ditolak.', 'rollback_denied', 403);
    return { versionId: row.version_id, label: row.label };
  });
}
