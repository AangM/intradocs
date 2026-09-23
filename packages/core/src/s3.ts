/**
 * Object storage for the blobs: an S3-compatible bucket (AWS S3, MinIO, Ceph RGW, ...)
 * spoken to directly -- four requests (PUT, GET, HEAD, and a bucket probe) signed with
 * AWS Signature Version 4 -- so there is no SDK to configure, audit or update.
 *
 * The contract is the same as the filesystem store: a key is written once and never
 * changed. S3 has no "create only" primitive except the conditional write
 * (`If-None-Match: *`, honoured by AWS since 2024 and by MinIO); a store that does not
 * implement it answers 501 or 400, and then the fallback is a HEAD before the PUT -- a
 * narrower guarantee, which the deployment guide states.
 */
import { createHash, createHmac } from 'node:crypto';
import type { BlobStore, StoredFile } from './ports.ts';
import { limitFor, sha256, validateStorageKey } from './storage.ts';

export interface S3Config {
  /** Origin of the service, e.g. https://s3.ap-southeast-1.amazonaws.com or https://minio.internal:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket, without leading or trailing slash; '' for none. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (https://host/bucket/key); virtual-hosted otherwise. MinIO wants path-style. */
  pathStyle: boolean;
  /** Ask the store to encrypt at rest (SSE-S3). */
  sse: boolean;
}

// --- SigV4 ----------------------------------------------------------------------------

const hex = (b: Buffer) => b.toString('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
const hash = (data: string | Uint8Array) => hex(createHash('sha256').update(data).digest());
/** RFC 3986 encoding as S3 expects it: every byte outside the unreserved set, '/' kept in paths. */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const ch of value) {
    if (/^[A-Za-z0-9\-_.~]$/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else
      for (const byte of Buffer.from(ch, 'utf8'))
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO basic time, e.g. 20260921T120000Z */
  amzDate: string;
}
/** Returns the Authorization header value for the request as given (headers must include host and x-amz-date). */
export function signV4(input: SignInput): string {
  const {
    method,
    url,
    headers,
    payloadHash,
    region,
    service,
    accessKeyId,
    secretAccessKey,
    amzDate,
  } = input;
  const date = amzDate.slice(0, 8);
  const lower = Object.entries(headers).map(
    ([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const,
  );
  lower.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = lower.map(([k]) => k).join(';');
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath =
    url.pathname === '' ? '/' : uriEncode(decodeURIComponent(url.pathname), true);
  const canonicalRequest = [
    method,
    canonicalPath,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hex(hmac(kSigning, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// --- the store --------------------------------------------------------------------------

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class S3BlobStore implements BlobStore {
  private readonly c: S3Config;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  /** Set once the store answered a conditional PUT with "not implemented". */
  private conditionalWrites: boolean | null = null;
  constructor(
    c: S3Config,
    options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {},
  ) {
    this.c = c;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.now = options.now ?? (() => new Date());
  }
  private objectUrl(key: string): URL {
    const objectKey = this.c.prefix ? `${this.c.prefix}/${key}` : key;
    const base = new URL(this.c.endpoint);
    if (this.c.pathStyle) base.pathname = `/${this.c.bucket}/${uriEncode(objectKey, true)}`;
    else {
      base.hostname = `${this.c.bucket}.${base.hostname}`;
      base.pathname = `/${uriEncode(objectKey, true)}`;
    }
    return base;
  }
  private bucketUrl(): URL {
    const base = new URL(this.c.endpoint);
    if (this.c.pathStyle) base.pathname = `/${this.c.bucket}/`;
    else {
      base.hostname = `${this.c.bucket}.${base.hostname}`;
      base.pathname = '/';
    }
    return base;
  }
  private async request(
    method: string,
    url: URL,
    extra: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const amzDate = this.now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const payloadHash = body ? hash(body) : hash('');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...extra,
    };
    if (body) headers['content-length'] = String(body.byteLength);
    headers.authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: this.c.region,
      service: 's3',
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
      amzDate,
    });
    // fetch sets host and content-length itself; they were only needed for the signature.
    const { host: _host, 'content-length': _length, ...sent } = headers;
    void _host;
    void _length;
    return this.fetchImpl(url, {
      method,
      headers: sent,
      body: body ? Buffer.from(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
  }
  private static async errorOf(r: Response): Promise<S3Error> {
    const text = await r.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${r.status}`;
    return new S3Error(`S3 ${r.status} ${code}`, r.status, code);
  }

  /** HEAD on the bucket: reachable, credentials accepted, bucket exists. */
  async probe(): Promise<void> {
    const r = await this.request('HEAD', this.bucketUrl(), {});
    if (!r.ok) throw await S3BlobStore.errorOf(r);
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<StoredFile> {
    validateStorageKey(key);
    if (bytes.byteLength > limitFor(key)) throw new Error('Artefak melebihi batas penyimpanan.');
    const digest = sha256(bytes);
    const url = this.objectUrl(key);
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      // The store checks the body against this and refuses a corrupted upload.
      'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
      ...(this.c.sse ? { 'x-amz-server-side-encryption': 'AES256' } : {}),
    };
    if (this.conditionalWrites !== false) {
      const r = await this.request('PUT', url, { ...headers, 'if-none-match': '*' }, bytes);
      if (r.ok) return { key, sha256: digest, size: bytes.byteLength };
      const error = await S3BlobStore.errorOf(r);
      if (r.status === 412) {
        // Already there: the same bytes are fine (a retry), different bytes are not.
        if (sha256(await this.read(key)) !== digest)
          throw new Error('Versi immutable tidak boleh ditimpa.');
        return { key, sha256: digest, size: bytes.byteLength };
      }
      if (r.status !== 501 && error.code !== 'NotImplemented') throw error;
      this.conditionalWrites = false;
    }
    // No conditional writes here: look first, then write. Two writers racing on one key
    // could both pass the HEAD; the key layout (one immutable key per version, chosen
    // by the database before the write) makes that a same-bytes race in practice.
    const head = await this.request('HEAD', url, {});
    if (head.ok) {
      if (sha256(await this.read(key)) !== digest)
        throw new Error('Versi immutable tidak boleh ditimpa.');
      return { key, sha256: digest, size: bytes.byteLength };
    }
    if (head.status !== 404) throw await S3BlobStore.errorOf(head);
    const r = await this.request('PUT', url, headers, bytes);
    if (!r.ok) throw await S3BlobStore.errorOf(r);
    return { key, sha256: digest, size: bytes.byteLength };
  }

  async read(key: string, expectedHash?: string): Promise<Uint8Array> {
    validateStorageKey(key);
    const r = await this.request('GET', this.objectUrl(key), {});
    if (r.status === 404) throw new Error('Artefak tidak valid.');
    if (!r.ok) throw await S3BlobStore.errorOf(r);
    const declared = Number(r.headers.get('content-length') ?? '0');
    if (declared > limitFor(key)) throw new Error('Artefak terlalu besar.');
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > limitFor(key)) throw new Error('Artefak terlalu besar.');
    if (expectedHash && sha256(bytes) !== expectedHash)
      throw new Error('Integritas artefak gagal.');
    return bytes;
  }
}
