// Protocol tests use a bounded fake local TCP peer. They do NOT certify antivirus detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import {
  ClamAVScanner,
  clamAVOptions,
  parseScannerVersion,
  parseScanVerdict,
} from '../../packages/core/src/clamav.ts';
import { UploadError, digest } from '../../packages/core/src/uploads.ts';
const now = new Date('2026-09-07T04:00:00Z');
const valid = 'ClamAV 1.4.6/30000/Mon Sep 7 02:00:00 2026';
test('patched LTS engine and recent signature are required', () => {
  const v = parseScannerVersion(valid, now);
  assert.equal(v.version, '1.4.6');
  assert.equal(v.signatureVersion, 30000);
});
for (const v of [
  valid.replace('1.4.6', '1.4.5'),
  valid.replace('1.4.6', '1.5.3'),
  'ClamAV 1.4.6/30000/Jan 1 2020',
  'ClamAV 1.4.6/30000/Jan 1 2030',
  'ClamAV 1.4.6',
  'OK',
  valid.replace('/30000/', '/0/'),
])
  test(`scanner identity/freshness fail closed: ${v}`, () =>
    assert.throws(() => parseScannerVersion(v, now)));
test('only exact clean result accepted; malware label never echoed', () => {
  assert.doesNotThrow(() => parseScanVerdict('stream: OK'));
  assert.throws(
    () => parseScanVerdict('stream: Synthetic-Signature FOUND'),
    (e: unknown) =>
      e instanceof UploadError &&
      e.code === 'malware_detected' &&
      !e.message.includes('Synthetic-Signature'),
  );
  for (const s of ['OK', 'stream: OK extra', 'stream: Size limit exceeded. ERROR', 'unknown'])
    assert.throws(() => parseScanVerdict(s));
});
test('scanner endpoint stays loopback, even with unrelated unsafe variables', () => {
  const v = clamAVOptions({
    APP_PROFILE: 'local-dev',
    CLAMAV_HOST: 'evil.example',
    SCANNER_DRIVER: 'mock',
  });
  assert.equal(v.host, '127.0.0.1');
  assert.equal(v.port, 3310);
  assert.throws(() => clamAVOptions({ APP_PROFILE: 'telkom-prod' }));
  assert.throws(() => clamAVOptions({}));
  // Staging and production scan too (a guard once limited this to local-dev, which
  // made every upload on a tunnel or server fail) -- and still only on loopback.
  for (const APP_PROFILE of ['staging', 'production']) {
    const s = clamAVOptions({ APP_PROFILE, CLAMAV_HOST: 'evil.example', CLAMAV_PORT: '3311' });
    assert.equal(s.host, '127.0.0.1');
    assert.equal(s.port, 3311);
  }
  assert.throws(() => clamAVOptions({ APP_PROFILE: 'local-dev', CLAMAV_PORT: '80' }));
});
async function peer(mode: 'ok' | 'found' | 'timeout' | 'broken' | 'oversize' = 'ok') {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let data = Buffer.alloc(0),
      stream = false;
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (mode === 'timeout') return;
      if (!stream) {
        const end = data.indexOf(0);
        if (end < 0) return;
        const command = data.subarray(0, end).toString();
        data = data.subarray(end + 1);
        if (mode === 'broken') {
          socket.end('partial');
          return;
        }
        if (mode === 'oversize') {
          socket.end('x'.repeat(2048));
          return;
        }
        if (command === 'zVERSION') {
          socket.end(`ClamAV 1.4.6/30000/${new Date().toUTCString()}\0`);
          return;
        }
        assert.equal(command, 'zINSTREAM');
        stream = true;
      }
      while (data.length >= 4) {
        const size = data.readUInt32BE(0);
        if (data.length < 4 + size) return;
        data = data.subarray(4);
        if (size === 0) {
          socket.end(mode === 'found' ? 'stream: Synthetic FOUND\0' : 'stream: OK\0');
          return;
        }
        received.push(data.subarray(0, size));
        data = data.subarray(size);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const scanner = new ClamAVScanner({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: mode === 'timeout' ? 30 : 1000,
    maxDefinitionAgeDays: 7,
  });
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  };
  return { scanner, received, stop };
}
test('INSTREAM frames transport every byte and return evidence bound to hash', async () => {
  const p = await peer();
  try {
    const bytes = Buffer.alloc(150000, 65);
    const evidence = await p.scanner.scan(bytes);
    assert.deepEqual(Buffer.concat(p.received), bytes);
    assert.equal(evidence.sha256, digest(bytes));
    assert.equal(evidence.verdict, 'clean');
  } finally {
    await p.stop();
  }
});
for (const mode of ['found', 'timeout', 'broken', 'oversize'] as const)
  test(`scanner ${mode} never becomes a clean result`, async () => {
    const p = await peer(mode);
    try {
      await assert.rejects(p.scanner.scan(Buffer.from('example')), UploadError);
    } finally {
      await p.stop();
    }
  });
test('aborted scan makes no successful response', async () => {
  const p = await peer('timeout');
  try {
    const c = new AbortController();
    c.abort();
    await assert.rejects(p.scanner.scan(Buffer.from('x'), c.signal), UploadError);
  } finally {
    await p.stop();
  }
});
