// Coordinator tests use explicit in-memory test doubles; no production mock mode exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ingestDraft,
  type DraftRepository,
  type UploadClaim,
  type DraftResult,
} from '../../packages/core/src/draft-ingestion.ts';
import { UploadError, digest } from '../../packages/core/src/uploads.ts';
import type { Actor } from '../../packages/core/src/index.ts';
import type { BlobStore } from '../../packages/core/src/ports.ts';
import type { MalwareScanner } from '../../packages/core/src/clamav.ts';
const actor: Actor = {
  id: 'test-author',
  name: 'Author Sintetis',
  email: 'author@example.test',
  unit: 'Demo',
  role: 'contributor',
  active: true,
  scopeAll: false,
};
const metadata = {
  title: 'Panduan demo',
  summary: '',
  categoryId: '10000000-0000-4000-8000-000000000001',
  classification: 'internal',
  labels: [],
  synthetic: true,
};
function setup() {
  const events: string[] = [],
    objects = new Map<string, Uint8Array>();
  let complete = false;
  const claim: UploadClaim = {
    ownerId: actor.id,
    requestId: randomUUID(),
    leaseToken: randomUUID(),
    documentId: randomUUID(),
    versionId: randomUUID(),
    payloadHash: 'x',
  };
  const result: DraftResult = {
    documentId: claim.documentId,
    versionId: claim.versionId,
    slug: 'panduan-demo',
    reused: false,
  };
  const repository: DraftRepository = {
    async reserve() {
      events.push('reserve');
      return complete ? { kind: 'complete', result } : { kind: 'claimed', claim };
    },
    async complete() {
      events.push('complete');
      complete = true;
      return result;
    },
    async fail() {
      events.push('fail');
    },
  };
  const scanner: MalwareScanner = {
    async scan(bytes) {
      events.push('scan');
      return {
        engine: 'clamav',
        version: '1.4.6',
        signatureVersion: 30000,
        signatureDate: new Date().toISOString(),
        scannedAt: new Date().toISOString(),
        verdict: 'clean',
        sha256: digest(bytes),
      };
    },
  };
  const storage: BlobStore = {
    async putImmutable(key, bytes) {
      events.push('store');
      objects.set(key, new Uint8Array(bytes));
      return { key, sha256: digest(bytes), size: bytes.length };
    },
    async read(key) {
      return objects.get(key)!;
    },
  };
  const input = {
    actor,
    requestId: claim.requestId,
    metadata,
    name: 'demo.md',
    mime: 'text/markdown',
    bytes: Buffer.from('# Demo\r\nIsi\n'),
  };
  return { events, objects, repository, scanner, storage, input };
}
test('real ordering contract: reserve → scan → immutable artifacts → transaction', async () => {
  const t = setup();
  const result = await ingestDraft(t.input, t);
  assert.deepEqual(t.events, ['reserve', 'scan', 'store', 'store', 'store', 'complete']);
  assert.equal(result.reused, false);
  assert.equal(t.objects.size, 3);
  const original = [...t.objects.entries()].find(([k]) => k.endsWith('original.md'))!;
  assert.deepEqual(Buffer.from(original[1]), t.input.bytes);
  const proof = JSON.parse(
    Buffer.from(
      [...t.objects.entries()].find(([k]) => k.endsWith('provenance.json'))![1],
    ).toString(),
  );
  assert.equal(proof.source.sha256, digest(t.input.bytes));
  assert.equal(proof.metadata.classification, 'internal');
  assert.equal(proof.mapping.sourceStart, 1);
});
test('successful retry does not rescan, rewrite files or duplicate document', async () => {
  const t = setup();
  const a = await ingestDraft(t.input, t);
  t.events.length = 0;
  const b = await ingestDraft(t.input, t);
  assert.equal(a.documentId, b.documentId);
  assert.equal(b.reused, true);
  assert.deepEqual(t.events, ['reserve']);
});
for (const role of ['viewer', 'inactive'] as const)
  test(`unauthorized ${role} is rejected before any side effect`, async () => {
    const t = setup();
    t.input.actor = role === 'viewer' ? { ...actor, role: 'viewer' } : { ...actor, active: false };
    await assert.rejects(ingestDraft(t.input, t), UploadError);
    assert.deepEqual(t.events, []);
  });
for (const error of ['scanner_unavailable', 'malware_detected'])
  test(`${error}: no stored bytes or draft`, async () => {
    const t = setup();
    t.scanner.scan = async () => {
      throw new UploadError(error, 'Rejected', 503);
    };
    await assert.rejects(ingestDraft(t.input, t), UploadError);
    assert.equal(t.objects.size, 0);
    assert.deepEqual(t.events, ['reserve', 'fail']);
  });
test('invalid UTF-8 is refused after scan and before any storage', async () => {
  const t = setup();
  t.input.bytes = Buffer.from([0xc3, 0x28]);
  await assert.rejects(ingestDraft(t.input, t), UploadError);
  assert.deepEqual(t.events, ['reserve', 'scan', 'fail']);
});
test('scanner hash mismatch fails closed', async () => {
  const t = setup();
  const scan = t.scanner.scan;
  t.scanner.scan = async (b) => ({ ...(await scan(b)), sha256: '0'.repeat(64) });
  await assert.rejects(ingestDraft(t.input, t), UploadError);
  assert.equal(t.objects.size, 0);
});
test('storage corruption cannot produce a completed draft', async () => {
  const t = setup();
  t.storage.putImmutable = async (key, bytes) => ({
    key,
    size: bytes.length,
    sha256: '0'.repeat(64),
  });
  await assert.rejects(ingestDraft(t.input, t), UploadError);
  assert(!t.events.includes('complete'));
  assert(t.events.includes('fail'));
});
test('late authorization/lease rejection keeps artifacts private and never reports success', async () => {
  const t = setup();
  t.repository.complete = async () => {
    throw new UploadError('forbidden', 'Akses berubah', 403);
  };
  await assert.rejects(ingestDraft(t.input, t), UploadError);
  assert.equal(t.objects.size, 3);
  assert(t.events.includes('fail'));
});
test('cleanup failure does not mask the original processing error', async () => {
  const t = setup();
  t.scanner.scan = async () => {
    throw new UploadError('scanner_unavailable', 'Tidak siap', 503);
  };
  t.repository.fail = async () => {
    throw new Error('DB unavailable');
  };
  await assert.rejects(
    ingestDraft(t.input, t),
    (e: unknown) => e instanceof UploadError && e.code === 'scanner_unavailable',
  );
});

test('oversized canonical is rejected before any immutable storage write', async () => {
  const t = setup();
  t.input.bytes = Buffer.from(('x'.repeat(1000) + '\n').repeat(2100));
  await assert.rejects(
    ingestDraft(t.input, t),
    (e: unknown) => e instanceof UploadError && e.status === 413,
  );
  assert.equal(t.objects.size, 0);
  assert(!t.events.includes('complete'));
});
