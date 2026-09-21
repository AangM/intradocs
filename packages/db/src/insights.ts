import type { RetrievalScope } from '@intradocs/core/rag';
import { withActor } from './index.ts';
import { listAuthorizedSources } from './rag.ts';

/**
 * Ingest-time model output (summary, generated questions) is read from WeKnora by the
 * web layer; this module only decides WHICH records an actor may ask about, under the
 * actor's own RLS, so nothing generated about an unreadable version can be fetched.
 */

export interface IndexedDocument {
  knowledgeId: string;
  versionId: string;
  /** The summary the version already carries, for the editor to compare against. */
  currentSummary: string;
  ownerId: string;
}

/** The indexed record behind a document's active version, if the actor may read it. */
export async function indexedDocument(
  actorId: string,
  documentId: string,
): Promise<IndexedDocument | null> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      knowledge_id: string;
      version_id: string;
      summary: string;
      owner_id: string;
    }>(
      `SELECT e.knowledge_id, e.version_id, v.summary, d.owner_id
       FROM app.rag_index_entries e
       JOIN app.document_versions v ON v.id=e.version_id
       JOIN app.documents d ON d.id=e.document_id
       WHERE e.document_id=$1`,
      [documentId],
    );
    const r = rows[0];
    return r
      ? {
          knowledgeId: r.knowledge_id,
          versionId: r.version_id,
          currentSummary: r.summary,
          ownerId: r.owner_id,
        }
      : null;
  });
}

export interface ScopedSource {
  knowledgeId: string;
  documentId: string;
  documentTitle: string;
}

/** A few readable sources within a scope; the caller asks WeKnora what questions they answer. */
export async function scopedSources(
  actorId: string,
  scope: RetrievalScope,
  limit: number,
): Promise<ScopedSource[]> {
  const sources = await listAuthorizedSources(actorId, 200, scope);
  return sources.slice(0, limit).map((s) => ({
    knowledgeId: s.knowledgeId,
    documentId: s.documentId,
    documentTitle: s.documentTitle,
  }));
}
