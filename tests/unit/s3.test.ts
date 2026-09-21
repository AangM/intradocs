import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { S3BlobStore, signV4, uriEncode, type S3Config } from '../../packages/core/src/s3.ts';
import { ConfigurationError, readS3 } from '../../packages/core/src/config.ts';

test('SigV4 reproduces the AWS test-suite "get-vanilla" signature', () => {
  // https://docs.aws.amazon.com/IAM/latest/UserGuide/signature-v4-test-suite.html
  const authorization = signV4({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: createHash('sha256').update('').digest('hex'),
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    amzDate: '20150830T123600Z',
  });
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('SigV4 "get-vanilla-query-order-key-case": query keys sorted, values encoded', () => {
  const authorization = signV4({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1'),
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: createHash('sha256').update('').digest('hex'),
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    amzDate: '20150830T123600Z',
  });
  assert.match(
    authorization,
    /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/,
  );
});

test('S3 URI encoding keeps unreserved characters and slashes in paths, encodes the rest', () => {
  assert.equal(uriEncode('documents/a b/ü.md', true), 'documents/a%20b/%C3%BC.md');
  assert.equal(uriEncode('a/b', false), 'a%2Fb');
  assert.equal(uriEncode('x-y_z.~', false), 'x-y_z.~');
});

const base = {
  APP_PROFILE: 'production',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://minio.internal:9000',
  S3_REGION: 'ap-southeast-1',
  S3_BUCKET: 'intradocs',
  S3_ACCESS_KEY_ID: 'AKIAINTRADOCS',
  S3_SECRET_ACCESS_KEY: 'Qx7Fv2Lm9Kd4Rt6Yh1Bn8Jw3Zs5Pc0Ae',
};
test('S3 config: https on a deployment, http loopback locally, sane bucket/prefix, no sample secret', () => {
  const c = readS3(base, true);
  assert.deepEqual(c, {
    driver: 's3',
    endpoint: 'https://minio.internal:9000',
    region: 'ap-southeast-1',
    bucket: 'intradocs',
    prefix: '',
    accessKeyId: 'AKIAINTRADOCS',
    secretAccessKey: base.S3_SECRET_ACCESS_KEY,
    pathStyle: true,
    sse: false,
  });
  assert.equal(readS3({ ...base, S3_PREFIX: '/tenant-a/blobs/' }, true).prefix, 'tenant-a/blobs');
  assert.equal(
    readS3({ ...base, S3_FORCE_PATH_STYLE: 'false', S3_SSE: 'true' }, true).pathStyle,
    false,
  );
  assert.equal(
    readS3({ ...base, S3_ENDPOINT: 'http://localhost:9000' }, false).endpoint,
    'http://localhost:9000',
  );
  assert.throws(
    () => readS3({ ...base, S3_ENDPOINT: 'http://localhost:9000' }, true),
    ConfigurationError,
  );
  assert.throws(
    () => readS3({ ...base, S3_ENDPOINT: 'http://minio.internal:9000' }, false),
    ConfigurationError,
  );
  assert.throws(
    () => readS3({ ...base, S3_ENDPOINT: 'https://minio.internal/bucket' }, true),
    ConfigurationError,
  );
  assert.throws(() => readS3({ ...base, S3_BUCKET: 'Bad_Bucket' }, true), ConfigurationError);
  assert.throws(() => readS3({ ...base, S3_PREFIX: '../x' }, true), ConfigurationError);
  assert.throws(
    () => readS3({ ...base, S3_SECRET_ACCESS_KEY: 'minioadmin' }, true),
    ConfigurationError,
  );
  assert.throws(() => readS3({ ...base, S3_ACCESS_KEY_ID: '' }, true), ConfigurationError);
});

/**
 * An in-memory bucket behind fetch: enough of S3 to exercise the store's contract --
 * conditional PUT (or not), GET with Content-Length, HEAD, 404s, XML error codes -- and
 * to record what was sent. Signatures are checked for shape, not recomputed: the
 * signing itself is proven against the AWS vectors above.
 */
function fakeS3(opts: { conditional: boolean }) {
  const objects = new Map<string, Uint8Array>();
  const log: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const xml = (status: number, code: string) =>
    new Response(`<Error><Code>${code}</Code></Error>`, {
      status,
      headers: { 'content-type': 'application/xml' },
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const method = init?.method ?? 'GET';
    log.push({ method, path: url.pathname, headers });
    assert.match(
      headers.authorization ?? '',
      /^AWS4-HMAC-SHA256 Credential=AKIAINTRADOCS\/\d{8}\/ap-southeast-1\/s3\/aws4_request, SignedHeaders=/,
    );
    assert.match(headers['x-amz-date'] ?? '', /^\d{8}T\d{6}Z$/);
    assert.equal(headers['x-amz-content-sha256']?.length, 64);
    if (url.pathname === '/intradocs/')
      return new Response(null, { status: method === 'HEAD' ? 200 : 405 });
    const key = decodeURIComponent(url.pathname.replace(/^\/intradocs\//, ''));
    if (method === 'PUT') {
      const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      const declared = headers['x-amz-checksum-sha256'];
      if (
        declared &&
        Buffer.from(createHash('sha256').update(body).digest()).toString('base64') !== declared
      )
        return xml(400, 'BadDigest');
      if (headers['if-none-match'] === '*') {
        if (!opts.conditional) return xml(501, 'NotImplemented');
        if (objects.has(key)) return xml(412, 'PreconditionFailed');
      }
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    const found = objects.get(key);
    if (method === 'HEAD')
      return new Response(null, {
        status: found ? 200 : 404,
        headers: found ? { 'content-length': String(found.byteLength) } : {},
      });
    if (method === 'GET')
      return found
        ? new Response(Buffer.from(found), {
            status: 200,
            headers: { 'content-length': String(found.byteLength) },
          })
        : xml(404, 'NoSuchKey');
    return xml(405, 'MethodNotAllowed');
  };
  return { objects, log, fetchImpl };
}
const config: S3Config = {
  endpoint: 'https://minio.internal:9000',
  region: 'ap-southeast-1',
  bucket: 'intradocs',
  prefix: '',
  accessKeyId: 'AKIAINTRADOCS',
  secretAccessKey: 'Qx7Fv2Lm9Kd4Rt6Yh1Bn8Jw3Zs5Pc0Ae',
  pathStyle: true,
  sse: true,
};
const key = 'documents/11111111-1111-4111-8111-111111111111/v1/original.md';
const bytes = new TextEncoder().encode('# Dokumen sintetis\n');

test('put once, read back with the hash checked, refuse a different body under the same key', async () => {
  const s3 = fakeS3({ conditional: true });
  const store = new S3BlobStore(config, { fetch: s3.fetchImpl });
  const stored = await store.putImmutable(key, bytes);
  assert.equal(stored.size, bytes.byteLength);
  assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
  const put = s3.log.find((l) => l.method === 'PUT')!;
  assert.equal(put.path, `/intradocs/${key}`);
  assert.equal(put.headers['if-none-match'], '*');
  assert.equal(put.headers['x-amz-server-side-encryption'], 'AES256');
  assert.deepEqual(await store.read(key, stored.sha256), bytes);
  await assert.rejects(() => store.read(key, 'a'.repeat(64)), /Integritas/);
  // A retry with the same bytes is fine; different bytes are not.
  await store.putImmutable(key, bytes);
  await assert.rejects(
    () => store.putImmutable(key, new TextEncoder().encode('lain')),
    /immutable/,
  );
  assert.equal(s3.objects.size, 1);
});

test('a store without conditional writes falls back to HEAD-then-PUT, once', async () => {
  const s3 = fakeS3({ conditional: false });
  const store = new S3BlobStore(config, { fetch: s3.fetchImpl });
  await store.putImmutable(key, bytes);
  assert.deepEqual(
    s3.log.map((l) => l.method),
    ['PUT', 'HEAD', 'PUT'],
  );
  s3.log.length = 0;
  await store.putImmutable(key.replace('v1', 'v2'), bytes);
  assert.deepEqual(
    s3.log.map((l) => l.method),
    ['HEAD', 'PUT'],
    'the 501 is remembered',
  );
  await assert.rejects(
    () => store.putImmutable(key, new TextEncoder().encode('lain')),
    /immutable/,
  );
});

test('missing objects, oversize artefacts and bad keys are refused like the filesystem store', async () => {
  const s3 = fakeS3({ conditional: true });
  const store = new S3BlobStore(config, { fetch: s3.fetchImpl });
  await assert.rejects(() => store.read(key), /tidak valid/);
  await assert.rejects(() => store.read('../etc/passwd'), /Storage key/);
  await assert.rejects(
    () => store.putImmutable('documents/x/v1/original.md', new Uint8Array(50 * 1024 * 1024 + 1)),
    /batas/,
  );
  await assert.rejects(
    () => store.putImmutable('documents/x/v1/markdown.md', new Uint8Array(2 * 1024 * 1024 + 1)),
    /batas/,
  );
  s3.objects.set('documents/x/v1/markdown.md', new Uint8Array(2 * 1024 * 1024 + 1));
  await assert.rejects(() => store.read('documents/x/v1/markdown.md'), /terlalu besar/);
});

test('a prefix and virtual-hosted style change only the URL', async () => {
  const s3 = fakeS3({ conditional: true });
  const seen: string[] = [];
  const store = new S3BlobStore(
    { ...config, prefix: 'tenant-a', pathStyle: false },
    {
      fetch: async (input, init) => {
        seen.push(String(input));
        return s3.fetchImpl(
          new URL(String(input)).href.replace(
            'intradocs.minio.internal:9000/',
            'minio.internal:9000/intradocs/',
          ),
          init,
        );
      },
    },
  );
  await store.probe();
  await store.putImmutable(key, bytes);
  assert.equal(seen[0], 'https://intradocs.minio.internal:9000/');
  assert.equal(seen[1], `https://intradocs.minio.internal:9000/tenant-a/${key}`);
});
