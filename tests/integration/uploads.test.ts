// Real PostgreSQL RLS/transactions; scanner is an explicit test double here.
// Run sequentially after setup. Live scanner + auth are covered by test:upload-http.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { loadActor, listDocuments } from '../../packages/db/src/queries.ts';
import {
  PostgresDraftRepository,
  readSourceMetadata,
  readUploadArtifact,
  uploadCategories,
} from '../../packages/db/src/uploads.ts';
import { withActor, closePools, getPool } from '../../packages/db/src/index.ts';
import { LocalBlobStore } from '../../packages/core/src/storage.ts';
import { ingestDraft } from '../../packages/core/src/draft-ingestion.ts';
import {
  parseDraftMetadata,
  validateTextFile,
  uploadFingerprint,
  digest,
  UploadError,
} from '../../packages/core/src/uploads.ts';
import type { Actor } from '../../packages/core/src/index.ts';
import type { MalwareScanner } from '../../packages/core/src/clamav.ts';
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const ids = [randomUUID(), randomUUID()];
const infra = '10000000-0000-4000-8000-000000000001',
  security = '10000000-0000-4000-8000-000000000002';
const repo = new PostgresDraftRepository();
let owner: Actor, peer: Actor, root: string, storage: LocalBlobStore;
const scanner: MalwareScanner = {
  async scan(bytes) {
    return {
      engine: 'clamav',
      version: '1.4.6',
      signatureVersion: 30000,
      signatureDate: new Date().toISOString(),
      scannedAt: new Date().toISOString(),
      sha256: digest(bytes),
      verdict: 'clean',
    };
  },
};
const base = {
  title: 'TEST M2a private source',
  summary: 'Only synthetic integration data',
  categoryId: infra,
  classification: 'internal',
  labels: ['Synthetic'],
  synthetic: true,
};
function input() {
  return {
    actor: owner,
    requestId: randomUUID(),
    metadata: { ...base, title: base.title + ' ' + randomUUID().slice(0, 8) },
    name: 'integration.md',
    mime: 'text/markdown',
    bytes: Buffer.from('# Synthetic\r\nPRIVATE-UPLOAD-CANARY\n'),
  };
}
before(async () => {
  assert(
    (await admin.query("SELECT to_regclass('app.version_sources') AS table_name")).rows[0]
      .table_name,
    'Apply migration 003 first',
  );
  for (const [i, id] of ids.entries()) {
    await admin.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
      [id, `M2a test ${i}`, `m2a-${id}@example.test`],
    );
    await admin.query(
      "INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES($1,$2,$3,'Synthetic test','contributor',true,false)",
      [id, `M2a test ${i}`, `m2a-${id}@example.test`],
    );
    for (const category of [infra, security])
      await admin.query('INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2)', [
        id,
        category,
      ]);
  }
  owner = (await loadActor(ids[0]!))!;
  peer = (await loadActor(ids[1]!))!;
  root = await mkdtemp(path.join(os.tmpdir(), 'intradocs-m2a-db-'));
  storage = new LocalBlobStore(root);
});
after(async () => {
  try {
    const docs = (
      await admin.query<{ id: string }>(
        'SELECT id FROM app.documents WHERE owner_id=ANY($1::text[])',
        [ids],
      )
    ).rows.map((r) => r.id);
    await admin.query(
      'DELETE FROM app.audit_events WHERE actor_id=ANY($1::text[]) OR document_id=ANY($2::uuid[])',
      [ids, docs],
    );
    await admin.query(
      'DELETE FROM app.version_sources WHERE version_id IN (SELECT id FROM app.document_versions WHERE document_id=ANY($1::uuid[]))',
      [docs],
    );
    await admin.query('DELETE FROM app.document_versions WHERE document_id=ANY($1::uuid[])', [
      docs,
    ]);
    await admin.query('DELETE FROM app.documents WHERE id=ANY($1::uuid[])', [docs]);
    await admin.query('DELETE FROM app.upload_requests WHERE owner_id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM app.category_grants WHERE user_id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM app.profiles WHERE id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM auth."user" WHERE id=ANY($1::text[])', [ids]);
  } finally {
    await closePools();
    await admin.end();
    if (root) await rm(root, { recursive: true, force: true });
  }
});
test('new ingestion tables force RLS; worker cannot read receipts or original metadata', async () => {
  const tables = await getPool().query(
    "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='app' AND relname IN ('upload_requests','version_sources')",
  );
  assert.equal(tables.rowCount, 2);
  for (const r of tables.rows) {
    assert(r.relrowsecurity);
    assert(r.relforcerowsecurity);
  }
  assert.equal((await getPool().query('SELECT * FROM app.upload_requests')).rowCount, 0);
  const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
  try {
    await assert.rejects(worker.query('SELECT * FROM app.version_sources'));
    await assert.rejects(worker.query('SELECT * FROM app.upload_requests'));
  } finally {
    await worker.end();
  }
});
test('category security floor applies even when the category is within scope', async () => {
  const categories = await uploadCategories(owner.id);
  assert(categories.find((c) => c.id === infra)?.allowed);
  assert.equal(categories.find((c) => c.id === security)?.minimumClassification, 'restricted');
  const i = input();
  i.metadata.categoryId = security;
  await assert.rejects(ingestDraft(i, { repository: repo, scanner, storage }));
});
test('scan/normalize/store/commit creates an unpublished owner-only document', async () => {
  const i = input(),
    result = await ingestDraft(i, { repository: repo, scanner, storage });
  const d = (await admin.query('SELECT * FROM app.documents WHERE id=$1', [result.documentId]))
    .rows[0];
  assert.equal(d.current_version_id, null);
  assert.equal(d.classification, 'internal');
  assert.equal(d.owner_id, owner.id);
  const v = (
    await admin.query('SELECT * FROM app.document_versions WHERE id=$1', [result.versionId])
  ).rows[0];
  assert.equal(v.review_state, 'draft');
  assert.equal(v.approved_by, null);
  assert.equal((await readSourceMetadata(owner.id, result.versionId))?.hash, digest(i.bytes));
  assert.equal(await readSourceMetadata(peer.id, result.versionId), null);
  assert.equal(await readUploadArtifact(peer.id, result.versionId, 'original'), null);
  assert.equal(await readUploadArtifact(peer.id, result.versionId, 'provenance'), null);
  const pub = await listDocuments(owner.id, {
    q: i.metadata.title,
    category: null,
    page: 1,
    status: 'published',
    sort: 'updated',
  });
  assert.equal(pub.total, 0);
  const mine = await listDocuments(owner.id, {
    q: i.metadata.title,
    category: null,
    page: 1,
    status: 'mine',
    sort: 'updated',
  });
  assert.equal(mine.items[0]?.id, result.documentId);
  const audit = await admin.query(
    "SELECT 1 FROM app.audit_events WHERE action='document.uploaded' AND document_id=$1",
    [result.documentId],
  );
  assert.equal(audit.rowCount, 1);
});
test('same request and same-author duplicates reuse one draft; other authors get no duplicate disclosure', async () => {
  const i = input();
  const a = await ingestDraft(i, { repository: repo, scanner, storage });
  const b = await ingestDraft(i, { repository: repo, scanner, storage });
  const c = await ingestDraft(
    { ...i, requestId: randomUUID() },
    { repository: repo, scanner, storage },
  );
  assert.equal(a.documentId, b.documentId);
  assert.equal(a.documentId, c.documentId);
  assert.equal(b.reused, true);
  assert.equal(c.reused, true);
  const other = await ingestDraft(
    { ...i, actor: peer, requestId: randomUUID() },
    { repository: repo, scanner, storage },
  );
  assert.notEqual(other.documentId, a.documentId);
  assert.equal(other.reused, false);
  await assert.rejects(
    ingestDraft({ ...i, bytes: Buffer.from('different') }, { repository: repo, scanner, storage }),
    (e: unknown) => e instanceof UploadError && e.code === 'idempotency_conflict',
  );
});
test('concurrent submissions share a serialized admission lease', async () => {
  const i = input(),
    metadata = parseDraftMetadata(i.metadata),
    file = validateTextFile(i.name, i.mime, i.bytes),
    hash = uploadFingerprint(file, metadata);
  const attempts = await Promise.allSettled([
    repo.reserve(owner, i.requestId, hash, metadata),
    repo.reserve(owner, i.requestId, hash, metadata),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const won = attempts.find((r) => r.status === 'fulfilled');
  assert(won?.status === 'fulfilled' && won.value.kind === 'claimed');
  await repo.fail(owner, won.value.claim, 'test_release');
});
test('expired processing lease is retried with a new immutable artifact version', async () => {
  const i = input(),
    m = parseDraftMetadata(i.metadata),
    hash = uploadFingerprint(validateTextFile(i.name, i.mime, i.bytes), m);
  const a = await repo.reserve(owner, i.requestId, hash, m);
  assert.equal(a.kind, 'claimed');
  if (a.kind !== 'claimed') return;
  await admin.query(
    "UPDATE app.upload_requests SET lease_until=now()-interval '1 minute' WHERE owner_id=$1 AND request_id=$2",
    [owner.id, i.requestId],
  );
  const b = await repo.reserve(owner, i.requestId, hash, m);
  assert.equal(b.kind, 'claimed');
  if (b.kind !== 'claimed') return;
  assert.notEqual(a.claim.versionId, b.claim.versionId);
  assert.equal(a.claim.documentId, b.claim.documentId);
  await repo.fail(owner, a.claim, 'stale_writer');
  const state = (
    await admin.query('SELECT state FROM app.upload_requests WHERE owner_id=$1 AND request_id=$2', [
      owner.id,
      i.requestId,
    ])
  ).rows[0];
  assert.equal(state.state, 'processing');
  await repo.fail(owner, b.claim, 'test_release');
});
test('revocation during scanning prevents DB commit; stored orphan bytes are never downloadable', async () => {
  const i = input();
  const revoked: MalwareScanner = {
    async scan(bytes) {
      await admin.query('DELETE FROM app.category_grants WHERE user_id=$1 AND category_id=$2', [
        owner.id,
        infra,
      ]);
      return scanner.scan(bytes);
    },
  };
  try {
    await assert.rejects(ingestDraft(i, { repository: repo, scanner: revoked, storage }));
    assert.equal(
      (await admin.query('SELECT id FROM app.documents WHERE title=$1', [i.metadata.title]))
        .rowCount,
      0,
    );
  } finally {
    await admin.query(
      'INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [owner.id, infra],
    );
  }
});
test('role downgrade removes access to a previously owned draft on the next query', async () => {
  const i = input(),
    d = await ingestDraft(i, { repository: repo, scanner, storage });
  try {
    await admin.query("UPDATE app.profiles SET role='viewer' WHERE id=$1", [owner.id]);
    assert.equal(await readSourceMetadata(owner.id, d.versionId), null);
    assert.equal(await readUploadArtifact(owner.id, d.versionId, 'original'), null);
  } finally {
    await admin.query("UPDATE app.profiles SET role='contributor' WHERE id=$1", [owner.id]);
  }
});
test('direct app SQL cannot publish, change source evidence, or insert a half-created draft', async () => {
  await assert.rejects(
    withActor(owner.id, async ({ client }) =>
      client.query(
        'UPDATE app.documents SET current_version_id=NULL WHERE owner_id=app.actor_id()',
      ),
    ),
  );
  await assert.rejects(
    withActor(owner.id, async ({ client }) =>
      client.query("UPDATE app.version_sources SET scan_verdict='clean'"),
    ),
  );
  await assert.rejects(
    withActor(owner.id, async ({ client }) =>
      client.query(
        "INSERT INTO app.documents(id,slug,title,category_id,owner_id,owner_label,classification) VALUES($1,'half','Half draft',$2,app.actor_id(),'Test','internal')",
        [randomUUID(), infra],
      ),
    ),
  );
});

test('operator maintenance refuses new upload admission instead of racing reference creation', async () => {
  const client = await admin.connect();
  try {
    await client.query('SELECT pg_advisory_lock(719283,1)');
    await assert.rejects(
      ingestDraft(input(), { repository: repo, scanner, storage }),
      (e: unknown) => e instanceof UploadError && e.code === 'storage_maintenance',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock(719283,1)');
    client.release();
  }
});
test('GC reference snapshot cannot run through an RLS-filtered app connection', async () => {
  const { readStorageReferences } = await import('../../packages/db/src/maintenance.ts');
  const app = await getPool().connect();
  try {
    await assert.rejects(readStorageReferences(app), /admin lokal/);
  } finally {
    app.release();
  }
  const rootClient = await admin.connect();
  try {
    const snapshot = await readStorageReferences(rootClient);
    assert(snapshot.keys.length >= 10);
    assert(snapshot.keys.some((k) => k.endsWith('/content.md')));
  } finally {
    rootClient.release();
  }
});
