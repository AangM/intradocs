import { Pool } from 'pg';
import type { RagExportClaim, RagExportRepository, RagIndexTarget } from '@intradocs/core/rag';
import { versionIdFromIndexTitle } from '@intradocs/core/rag';
import type { WeknoraClient } from '@intradocs/core/weknora';

// EXECUTE on four fixed functions; never SELECT on business tables. Every eligibility
// decision stays in SQL, so a bug here cannot widen what gets indexed.
export class PostgresRagExportRepository implements RagExportRepository {
  constructor(private readonly pool: Pool) {}
  async reconcile(): Promise<number> {
    const { rows } = await this.pool.query<{ queued: string }>(
      'SELECT app.reconcile_rag_exports() AS queued',
    );
    return Number(rows[0]?.queued ?? 0);
  }
  async claim(): Promise<RagExportClaim | null> {
    const { rows } = await this.pool.query<{
      job_id: string;
      lease: string;
      version: string;
      document: string;
      markdown_key: string;
      markdown_hash: string;
      operation: string;
      knowledge_id: string | null;
      document_title: string;
      version_label: string;
      classification: string;
      category_name: string;
    }>('SELECT * FROM app.claim_rag_export()');
    const r = rows[0];
    if (!r) return null;
    if (r.operation !== 'upsert' && r.operation !== 'remove')
      throw new Error('Operasi antrean tidak dikenal.');
    return {
      jobId: r.job_id,
      leaseToken: r.lease,
      versionId: r.version,
      documentId: r.document,
      markdownKey: r.markdown_key,
      markdownHash: r.markdown_hash,
      operation: r.operation,
      knowledgeId: r.knowledge_id,
      documentTitle: r.document_title,
      versionLabel: r.version_label,
      classification: r.classification,
      categoryName: r.category_name,
    };
  }
  async complete(
    claim: RagExportClaim,
    result: { knowledgeId: string | null; sourceHash: string; chunkCount: number },
  ): Promise<void> {
    await this.pool.query('SELECT app.complete_rag_export($1,$2,$3,$4,$5)', [
      claim.jobId,
      claim.leaseToken,
      result.knowledgeId,
      result.sourceHash || null,
      result.chunkCount,
    ]);
  }
  async fail(claim: RagExportClaim): Promise<void> {
    await this.pool.query('SELECT app.fail_rag_export($1,$2)', [claim.jobId, claim.leaseToken]);
  }
}

/**
 * WeKnora seen through the exporter's narrow interface.
 *
 * findByTitle exists for one case only: a crash between creating the record in WeKnora
 * and recording its ID in IntraDocs. Looking the title up recovers the orphan instead of
 * creating a duplicate on the next attempt.
 */
export class WeknoraIndexTarget implements RagIndexTarget {
  constructor(private readonly client: WeknoraClient) {}
  async create(input: { title: string; content: string }): Promise<string> {
    return this.client.createManualKnowledge(input);
  }
  async update(knowledgeId: string, input: { title: string; content: string }): Promise<void> {
    await this.client.updateManualKnowledge(knowledgeId, input);
  }
  async remove(knowledgeId: string): Promise<void> {
    await this.client.deleteKnowledge(knowledgeId);
  }
  async findByTitle(title: string): Promise<string | null> {
    const versionId = versionIdFromIndexTitle(title);
    if (!versionId) return null;
    const found = await this.client.findKnowledgeByKeyword(versionId);
    // Match on the parsed version ID, never on a fuzzy keyword hit, so an unrelated
    // record that merely mentions the ID cannot be adopted and then overwritten.
    const exact = found.filter((k) => versionIdFromIndexTitle(k.title) === versionId);
    return exact.length === 1 ? exact[0]!.id : null;
  }
}
