import { createConnection } from 'node:net';
import { UploadError, UPLOAD_LIMITS, digest } from './uploads.ts';
export interface ScanEvidence {
  engine: 'clamav';
  version: string;
  signatureVersion: number;
  signatureDate: string;
  scannedAt: string;
  sha256: string;
  verdict: 'clean';
}
export interface MalwareScanner {
  scan(bytes: Uint8Array, signal?: AbortSignal): Promise<ScanEvidence>;
}
export type ClamAVOptions = {
  host: string;
  port: number;
  timeoutMs: number;
  maxDefinitionAgeDays: number;
};
// Every profile scans; the scanner is always reached on loopback, whatever the environment
// says, so a misconfigured host can never route uploads to an unknown scanner.
const SCANNING_PROFILES = new Set(['local-dev', 'staging', 'production']);
export function clamAVOptions(env: Record<string, string | undefined>): ClamAVOptions {
  if (!SCANNING_PROFILES.has(env.APP_PROFILE ?? ''))
    throw new UploadError('scanner_config', 'Profil aplikasi tidak dikenal untuk pemindai.', 503);
  const port = Number(env.CLAMAV_PORT ?? '3310');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new UploadError('scanner_config', 'CLAMAV_PORT tidak valid.', 503);
  return { host: '127.0.0.1', port, timeoutMs: 20000, maxDefinitionAgeDays: 7 };
}
function unavailable(): UploadError {
  return new UploadError(
    'scanner_unavailable',
    'Pemindai lokal belum siap. Jalankan pnpm knowledge:start dan pnpm scanner:check.',
    503,
    10,
  );
}
export function parseScannerVersion(
  value: string,
  now: Date,
  maxAgeDays = 7,
): { version: string; signatureVersion: number; signatureDate: string } {
  const match = /^ClamAV (\d+)\.(\d+)\.(\d+)\/(\d+)\/(.+)$/.exec(value.trim());
  if (!match) throw unavailable();
  const major = Number(match[1]),
    minor = Number(match[2]),
    patch = Number(match[3]);
  const patched =
    major > 1 ||
    (major === 1 && (minor > 5 || (minor === 5 && patch >= 4) || (minor === 4 && patch >= 6)));
  const date = match[5]!.trim();
  const epoch = Date.parse(/(?:Z|[+-]\d{4}|GMT|UTC)$/.test(date) ? date : date + ' UTC');
  if (
    !patched ||
    !Number.isFinite(epoch) ||
    epoch > now.getTime() + 86400000 ||
    now.getTime() - epoch > maxAgeDays * 86400000
  )
    throw new UploadError(
      'scanner_outdated',
      'Engine atau database pemindai belum mutakhir. Perbarui ClamAV dan tunggu update signature.',
      503,
      60,
    );
  const signatureVersion = Number(match[4]);
  if (!Number.isSafeInteger(signatureVersion) || signatureVersion < 1) throw unavailable();
  return {
    version: `${major}.${minor}.${patch}`,
    signatureVersion,
    signatureDate: new Date(epoch).toISOString(),
  };
}
export function parseScanVerdict(value: string): void {
  if (value === 'stream: OK') return;
  if (/^stream: .+ FOUND$/.test(value))
    throw new UploadError(
      'malware_detected',
      'Berkas ditolak oleh pemindai malware. Tidak ada draft yang dibuat.',
      422,
    );
  throw unavailable();
}
async function exchange(
  options: ClamAVOptions,
  command: 'VERSION' | 'INSTREAM',
  bytes?: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new UploadError('cancelled', 'Unggahan dibatalkan.');
  return new Promise((resolve, reject) => {
    let finished = false;
    let response = Buffer.alloc(0);
    const socket = createConnection({ host: options.host, port: options.port });
    const deadline = setTimeout(() => finish(unavailable()), options.timeoutMs);
    const abort = () => finish(new UploadError('cancelled', 'Unggahan dibatalkan.'));
    function finish(error?: Error, result?: string) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(unavailable()));
    socket.on('close', () => {
      if (!finished) finish(unavailable());
    });
    socket.on('data', (chunk: Buffer) => {
      if (response.length + chunk.length > 1024) {
        finish(unavailable());
        return;
      }
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf(0);
      if (end >= 0) {
        if (end !== response.length - 1) finish(unavailable());
        else finish(undefined, response.subarray(0, end).toString('utf8').trim());
      }
    });
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (command === 'INSTREAM') {
        const data = bytes!;
        let offset = 0;
        const send = () => {
          if (finished) return;
          while (offset < data.byteLength) {
            const chunk = data.subarray(offset, Math.min(offset + 65536, data.byteLength));
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.byteLength);
            offset += chunk.byteLength;
            if (!socket.write(Buffer.concat([size, chunk]))) {
              socket.once('drain', send);
              return;
            }
          }
          socket.write(Buffer.alloc(4));
        };
        send();
      }
    });
    if (signal?.aborted) abort();
  });
}
export class ClamAVScanner implements MalwareScanner {
  private readonly options: ClamAVOptions;
  constructor(options: ClamAVOptions) {
    this.options = options;
  }
  async readiness(): Promise<{ version: string; signatureVersion: number; signatureDate: string }> {
    return parseScannerVersion(
      await exchange(this.options, 'VERSION'),
      new Date(),
      this.options.maxDefinitionAgeDays,
    );
  }
  async scan(bytes: Uint8Array, signal?: AbortSignal): Promise<ScanEvidence> {
    if (bytes.length > UPLOAD_LIMITS.binaryBytes)
      throw new UploadError('file_too_large', 'Berkas terlalu besar.', 413);
    const before = parseScannerVersion(
      await exchange(this.options, 'VERSION', undefined, signal),
      new Date(),
      this.options.maxDefinitionAgeDays,
    );
    parseScanVerdict(await exchange(this.options, 'INSTREAM', bytes, signal));
    const version = parseScannerVersion(
      await exchange(this.options, 'VERSION', undefined, signal),
      new Date(),
      this.options.maxDefinitionAgeDays,
    );
    if (
      before.version !== version.version ||
      before.signatureVersion !== version.signatureVersion ||
      before.signatureDate !== version.signatureDate
    )
      throw new UploadError(
        'scanner_changed',
        'Database pemindai sedang diperbarui. Coba kembali sebentar lagi.',
        503,
        5,
      );
    return {
      engine: 'clamav',
      ...version,
      scannedAt: new Date().toISOString(),
      sha256: digest(bytes),
      verdict: 'clean',
    };
  }
}
