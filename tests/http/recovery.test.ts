// Real database leases and rollback. A row lock keeps the running worker from
// stealing a test claim, without adding a production/test-mode bypass.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { localAdminUrl, ROOT } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import { lexicalChunks } from '../../packages/core/src/workflow.ts';
import { digest } from '../../packages/core/src/uploads.ts';
import { LocalBlobStore } from '../../packages/core/src/storage.ts';
import path from 'node:path';
const admin = new Pool({ connectionString: localAdminUrl(), max: 2 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 1 });
const store = new LocalBlobStore(path.join(ROOT, process.env.STORAGE_ROOT!));
let documentId: string, versionId: string, jobId: string;
const body = '# Isolated retry fixture\nLossless retry and atomic commit.\n';
before(async () => {
  documentId = randomUUID();
  versionId = randomUUID();
  jobId = randomUUID();
  const key = `documents/${documentId}/versions/${versionId}/content.md`;
  await store.putImmutable(key, Buffer.from(body));
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO app.documents(id,slug,title,category_id,owner_id,owner_label,classification) VALUES($1,$2,'Recovery fixture',$3,$4,'Synthetic','internal')",
      [documentId, 'recovery-' + documentId, IDS.infra, IDS.contributor],
    );
    await c.query(
      "INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,byte_size,approved_by,approved_by_label,approved_at) VALUES($1,$2,'1.0','approved',$3,$4,$5,$6,'Synthetic reviewer',now())",
      [versionId, documentId, key, digest(body), Buffer.byteLength(body), IDS.super],
    );
    await c.query(
      "UPDATE app.document_versions SET publication_state='unpublished',processing_state='indexing' WHERE id=$1",
      [versionId],
    );
    jobId = (
      await c.query(
        "UPDATE app.publication_outbox SET available_at=now()+interval '1 day' WHERE version_id=$1 RETURNING id",
        [versionId],
      )
    ).rows[0].id;
    const request = (
      await c.query(
        "INSERT INTO app.approval_requests(version_id,document_id,revision_hash,submitted_by,required_steps,state,decided_at,review_at) VALUES($1,$2,$3,$4,1,'approved',now(),now()+interval '180 days') RETURNING id",
        [versionId, documentId, digest(body), IDS.contributor],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO app.approval_steps(request_id,stage,reviewer_id,decision,decided_at) VALUES($1,1,$2,'approve',now())",
      [request, IDS.super],
    );
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
});
after(async () => {
  try {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE app.documents SET current_version_id=NULL WHERE id=$1', [documentId]);
      for (const t of [
        'notifications',
        'index_generations',
        'lexical_chunks',
        'publication_outbox',
      ])
        await c.query(`DELETE FROM app.${t} WHERE version_id=$1`, [versionId]);
      await c.query('DELETE FROM app.audit_events WHERE document_id=$1', [documentId]);
      await c.query(
        'DELETE FROM app.approval_steps WHERE request_id IN(SELECT id FROM app.approval_requests WHERE version_id=$1)',
        [versionId],
      );
      await c.query('DELETE FROM app.approval_requests WHERE version_id=$1', [versionId]);
      await c.query('DELETE FROM app.document_versions WHERE id=$1', [versionId]);
      await c.query('DELETE FROM app.documents WHERE id=$1', [documentId]);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  } finally {
    await admin.end();
    await worker.end();
  }
});
test('expired claim is reclaimed with fresh token; stale token cannot publish or fail it', async () => {
  const old = randomUUID();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "UPDATE app.publication_outbox SET state='running',attempts=1,lease_token=$2,lease_until=now()-interval '1 second',available_at=now()-interval '1 second' WHERE id=$1",
      [jobId, old],
    );
    await c.query('SELECT id FROM app.publication_outbox WHERE id=$1 FOR UPDATE', [jobId]);
    await c.query('SET LOCAL ROLE intradocs_worker');
    const claim = (await c.query('SELECT * FROM app.claim_publication()')).rows.find(
      (r: { job_id: string }) => r.job_id === jobId,
    );
    assert(claim);
    assert.notEqual(claim.lease_token, old);
    await c.query('SAVEPOINT stale');
    await assert.rejects(
      c.query('SELECT app.publish_lexical($1,$2,$3::jsonb)', [
        jobId,
        old,
        JSON.stringify(lexicalChunks(body)),
      ]),
      (e: { code: string }) => e.code === '40001',
    );
    await c.query('ROLLBACK TO SAVEPOINT stale');
    await c.query('SELECT app.fail_publication($1,$2)', [jobId, old]);
    await c.query('RESET ROLE');
    const fresh = (
      await c.query('SELECT state,attempts,lease_token FROM app.publication_outbox WHERE id=$1', [
        jobId,
      ])
    ).rows[0];
    assert.equal(fresh.state, 'running');
    assert.equal(fresh.attempts, 2);
    assert.equal(fresh.lease_token, claim.lease_token);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
});
test('failure records bounded retry/dead state without a public pointer; owner can retry', async () => {
  const token = randomUUID();
  await admin.query(
    "UPDATE app.publication_outbox SET state='running',attempts=5,lease_token=$2,lease_until=now()+interval '90 seconds',available_at=now()+interval '1 day' WHERE id=$1",
    [jobId, token],
  );
  await worker.query('SELECT app.fail_publication($1,$2)', [jobId, token]);
  const r = (
    await admin.query(
      'SELECT o.state,v.processing_state,d.current_version_id FROM app.publication_outbox o JOIN app.document_versions v ON v.id=o.version_id JOIN app.documents d ON d.id=v.document_id WHERE o.id=$1',
      [jobId],
    )
  ).rows[0];
  assert.equal(r.state, 'dead');
  assert.equal(r.processing_state, 'failed');
  assert.equal(r.current_version_id, null);
  // Retry authorization executes under a real application role and transaction actor.
  const app = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.actor_id',$1,true)", [IDS.contributor]);
    await c.query('SELECT app.retry_publication($1)', [versionId]);
    await c.query('COMMIT');
  } finally {
    c.release();
    await app.end();
  }
});
