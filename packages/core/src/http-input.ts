import { InputError } from './validation.ts';
export class BodyLimitError extends InputError {}
export class BodyReadError extends InputError {
  readonly kind: 'timeout' | 'cancelled' | 'invalid_stream';
  constructor(kind: 'timeout' | 'cancelled' | 'invalid_stream') {
    super(
      kind === 'timeout'
        ? 'Pembacaan request melewati batas waktu.'
        : kind === 'cancelled'
          ? 'Request dibatalkan.'
          : 'Stream request tidak valid.',
    );
    this.kind = kind;
  }
}
// Bounded by bytes and time. Never await an uncooperative transport cancellation hook.
export async function readBoundedBytes(
  request: Request,
  limit: number,
  timeoutMs = 15000,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new InputError('Batas request tidak valid.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new BodyLimitError('Payload terlalu besar.');
  if (request.signal.aborted) throw new BodyReadError('cancelled');
  if (!request.body) return new Uint8Array(0);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw new BodyReadError('invalid_stream');
  }
  let stopped: 'timeout' | 'cancelled' | undefined;
  let length = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => {
    stopped ??= 'cancelled';
    cancel();
  };
  const timer = setTimeout(() => {
    stopped ??= 'timeout';
    cancel();
  }, timeoutMs);
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    if (request.signal.aborted) abort();
    while (true) {
      const { done, value } = await reader.read();
      if (stopped) throw new BodyReadError(stopped);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new BodyReadError('invalid_stream');
      length += value.byteLength;
      if (length > limit) {
        cancel();
        throw new BodyLimitError('Payload terlalu besar.');
      }
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    if (error instanceof BodyLimitError || error instanceof BodyReadError) throw error;
    cancel();
    throw new BodyReadError(stopped ?? 'invalid_stream');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function readBoundedText(
  request: Request,
  limit: number,
  timeoutMs = 15000,
): Promise<string> {
  const bytes = await readBoundedBytes(request, limit, timeoutMs);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InputError('Encoding payload tidak valid.');
  }
}
export function parseLoginBody(text: string): { email: string; password: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError('JSON tidak valid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Payload tidak valid.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !['email', 'password'].includes(k)) ||
    typeof v.email !== 'string' ||
    typeof v.password !== 'string' ||
    v.email.length > 254 ||
    v.password.length > 128 ||
    !v.email ||
    !v.password
  )
    throw new InputError('Field login tidak valid.');
  return { email: v.email.trim(), password: v.password };
}
