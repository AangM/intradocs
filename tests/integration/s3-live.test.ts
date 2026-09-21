/**
 * The S3 store against a real S3-compatible service. Skipped unless S3_TEST_ENDPOINT is
 * set (a MinIO in Docker is enough):
 *
 *   docker run -d -p 127.0.0.1:9000:9000 -e MINIO_ROOT_USER=u -e MINIO_ROOT_PASSWORD=p quay.io/minio/minio server /data
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_KEY=u S3_TEST_SECRET=p pnpm test:integration
 *
 * What is proven here and nowhere else: the signature is accepted by a real
 * implementation for PUT, GET and HEAD, the conditional write really refuses a second
 * body, the checksum header really rejects a corrupted upload, and the bucket probe
 * distinguishes a bucket that exists from one that does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { S3BlobStore, signV4, type S3Config } from '../../packages/core/src/s3.ts';

const endpoint = process.env.S3_TEST_ENDPOINT;
const config: S3Config = {
  endpoint: endpoint ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: `intradocs-test-${randomUUID().slice(0, 8)}`,
  prefix: 'blobs',
  accessKeyId: process.env.S3_TEST_KEY ?? '',
  secretAccessKey: process.env.S3_TEST_SECRET ?? '',
  pathStyle: true,
  sse: false,
};

/** One signed request outside the store, for bucket create/delete the store never does. */
async function raw(method: string, path: string, body?: Uint8Array) {
  const url = new URL(path, config.endpoint);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const payloadHash = createHash('sha256')
    .update(body ?? '')
    .digest('hex');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  headers.authorization = signV4({
    method,
    url,
    headers,
    payloadHash,
    region: config.region,
    service: 's3',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    amzDate,
  });
  const { host: _h, ...sent } = headers;
  void _h;
  return fetch(url, { method, headers: sent, body: body ? Buffer.from(body) : undefined });
}

test('live S3: sign, put once, read, refuse a second body, refuse a corrupted upload, probe', async (t) => {
  if (!endpoint) return t.skip('S3_TEST_ENDPOINT not set');
  const store = new S3BlobStore(config, { timeoutMs: 10000 });
  await assert.rejects(() => store.probe(), /404|NoSuchBucket/, 'no bucket yet');
  assert.equal((await raw('PUT', `/${config.bucket}`)).status, 200, 'create bucket');
  try {
    await store.probe();
    const key = `documents/${randomUUID()}/v1/original.md`;
    const bytes = new TextEncoder().encode('# Dokumen sintetis untuk uji S3\n');
    const stored = await store.putImmutable(key, bytes);
    assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await store.read(key, stored.sha256), bytes);
    await store.putImmutable(key, bytes);
    await assert.rejects(
      () => store.putImmutable(key, new TextEncoder().encode('lain')),
      /immutable/,
    );
    assert.deepEqual(await store.read(key), bytes, 'the first body survived');
    await assert.rejects(() => store.read(key.replace('v1', 'v9')), /tidak valid/);
    // A corrupted upload: the checksum header names other bytes than the body carries.
    const url = new URL(`/${config.bucket}/blobs/documents/x/v1/original.md`, config.endpoint);
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const body = new TextEncoder().encode('isi');
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'x-amz-checksum-sha256': createHash('sha256').update('bukan isi').digest('base64'),
    };
    headers.authorization = signV4({
      method: 'PUT',
      url,
      headers,
      payloadHash,
      region: config.region,
      service: 's3',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      amzDate,
    });
    const { host: _h, ...sent } = headers;
    void _h;
    const bad = await fetch(url, { method: 'PUT', headers: sent, body: Buffer.from(body) });
    assert.equal(
      bad.status,
      400,
      'the store refuses bytes that do not match the declared checksum',
    );
    // Clean up: delete the object, then the bucket.
    assert.equal((await raw('DELETE', `/${config.bucket}/blobs/${key}`)).status, 204);
  } finally {
    await raw('DELETE', `/${config.bucket}`);
  }
});
