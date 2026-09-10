import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readUploadBytes } from '../../packages/core/src/upload-request.ts';
import { readBoundedText, BodyLimitError } from '../../packages/core/src/http-input.ts';
import { ingestDraft, type DraftRepository } from '../../packages/core/src/draft-ingestion.ts';
import { digest, UploadError } from '../../packages/core/src/uploads.ts';
import type { Actor } from '../../packages/core/src/index.ts';
import type { BlobStore } from '../../packages/core/src/ports.ts';
import type { MalwareScanner } from '../../packages/core/src/clamav.ts';
const url = 'http:' + '//localhost/api/documents/drafts';
function stalledCancellation() {
  return new Request(url, {
    method: 'POST',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(20));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    }),
    duplex: 'half',
  } as RequestInit);
}
for (const kind of ['upload', 'json'] as const)
  test(`oversize ${kind} rejects even if transport cancellation never resolves`, async () => {
    const request = stalledCancellation();
    const pending =
      kind === 'upload' ? readUploadBytes(request, 10, 30) : readBoundedText(request, 10);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(
          () => 'resolved',
          (e: unknown) => (e instanceof BodyLimitError ? 'limited' : 'wrong-error'),
        ),
        new Promise<string>((r) => {
          timer = setTimeout(() => r('hung'), 100);
        }),
      ]);
      assert.equal(outcome, 'limited');
    } finally {
      clearTimeout(timer);
    }
  });
function fixture() {
  const actor: Actor = {
    id: 'synthetic-owner',
    name: 'Author',
    email: 'owner@example.test',
    role: 'contributor',
    active: true,
    scopeAll: false,
    unit: 'Synthetic',
  };
  const requestId = randomUUID(),
    documentId = randomUUID(),
    versionId = randomUUID(),
    controller = new AbortController();
  const calls: string[] = [];
  const repository: DraftRepository = {
    async reserve(_actor, _requestId, payloadHash) {
      return {
        kind: 'claimed',
        claim: {
          ownerId: actor.id,
          requestId,
          documentId,
          versionId,
          leaseToken: randomUUID(),
          payloadHash,
        },
      };
    },
    async complete() {
      calls.push('commit');
      return { documentId, versionId, slug: 'demo', reused: false };
    },
    async fail() {
      calls.push('fail');
    },
  };
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
  const storage: BlobStore = {
    async putImmutable(key, bytes) {
      calls.push('store');
      return { key, sha256: digest(bytes), size: bytes.length };
    },
    async read() {
      throw new Error('Not used');
    },
  };
  const input = {
    actor,
    requestId,
    name: 'demo.md',
    mime: 'text/markdown',
    bytes: Buffer.from('# Synthetic\n'),
    signal: controller.signal,
    metadata: {
      title: 'Synthetic demo',
      summary: '',
      categoryId: '10000000-0000-4000-8000-000000000001',
      classification: 'internal',
      labels: [],
      synthetic: true,
    },
  };
  return { input, repository, scanner, storage, calls, controller };
}
test('mutation of original bytes by an adapter cannot create a mismatched source proof', async () => {
  const f = fixture();
  f.storage.putImmutable = async (key, bytes) => {
    if (key.endsWith('original.md')) bytes[0] = 65;
    return { key, sha256: digest(bytes), size: bytes.length };
  };
  await assert.rejects(ingestDraft(f.input, f), UploadError);
  assert(!f.calls.includes('commit'));
});
test('abort after one artifact stops subsequent writes and DB commit', async () => {
  const f = fixture();
  f.storage.putImmutable = async (key, bytes) => {
    f.calls.push('store');
    f.controller.abort();
    return { key, sha256: digest(bytes), size: bytes.length };
  };
  await assert.rejects(ingestDraft(f.input, f), UploadError);
  assert.deepEqual(f.calls, ['store', 'fail']);
});
