import { Pool } from 'pg';
import type {
  PublicationClaim,
  PublicationRepository,
  LexicalChunk,
} from '@intradocs/core/workflow';

// This role has EXECUTE on three fixed functions; never SELECT on business tables.
export class PostgresPublicationRepository implements PublicationRepository {
  constructor(private readonly pool: Pool) {}
  async claim(): Promise<PublicationClaim | null> {
    const { rows } = await this.pool.query<{
      job_id: string;
      lease_token: string;
      version_id: string;
      document_id: string;
      markdown_key: string;
      markdown_hash: string;
    }>('SELECT * FROM app.claim_publication()');
    const r = rows[0];
    return r
      ? {
          jobId: r.job_id,
          leaseToken: r.lease_token,
          versionId: r.version_id,
          documentId: r.document_id,
          markdownKey: r.markdown_key,
          markdownHash: r.markdown_hash,
        }
      : null;
  }
  async publish(claim: PublicationClaim, chunks: LexicalChunk[]): Promise<void> {
    await this.pool.query('SELECT app.publish_lexical($1,$2,$3::jsonb)', [
      claim.jobId,
      claim.leaseToken,
      JSON.stringify(chunks),
    ]);
  }
  async fail(claim: PublicationClaim): Promise<void> {
    await this.pool.query('SELECT app.fail_publication($1,$2)', [claim.jobId, claim.leaseToken]);
  }
}
