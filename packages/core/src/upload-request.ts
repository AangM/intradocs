import { BodyLimitError, BodyReadError, readBoundedBytes } from './http-input.ts';
import { UploadError, UPLOAD_LIMITS, parseDraftMetadata } from './uploads.ts';
import { parseUuid } from './validation.ts';
export async function readUploadBytes(
  request: Request,
  limit = UPLOAD_LIMITS.bodyBytes,
  timeoutMs = 15000,
): Promise<Uint8Array> {
  if (!request.body) throw new UploadError('empty_request', 'Tidak ada berkas.');
  try {
    return await readBoundedBytes(request, limit, timeoutMs);
  } catch (error) {
    if (error instanceof BodyReadError) {
      if (error.kind === 'timeout')
        throw new UploadError('upload_timeout', 'Unggahan terlalu lambat. Silakan coba lagi.', 408);
      if (error.kind === 'cancelled') throw new UploadError('cancelled', 'Unggahan dibatalkan.');
      throw new UploadError('invalid_request', 'Stream unggahan tidak valid.');
    }
    throw error;
  }
}
export async function parseUploadRequest(request: Request) {
  const requestId = parseUuid(request.headers.get('idempotency-key')),
    contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType) || contentType.length > 256)
    throw new UploadError('invalid_request', 'Gunakan unggahan berkas multipart/form-data.', 415);
  const bytes = await readUploadBytes(request);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': contentType },
    }).formData();
  } catch {
    throw new UploadError('invalid_request', 'Format upload tidak valid.');
  }
  const allowed = new Set([
    'file',
    'title',
    'summary',
    'categoryId',
    'classification',
    'labels',
    'synthetic',
  ]);
  if (form.has('documentId') || form.has('baseVersionId')) {
    allowed.add('documentId');
    allowed.add('baseVersionId');
  }
  const attachments = form.getAll('attachments');
  if (
    attachments.length > UPLOAD_LIMITS.attachments ||
    attachments.some((a) => !(a instanceof File))
  )
    throw new UploadError('invalid_request', 'Maksimal empat lampiran berupa berkas.');
  const entries = [...form.entries()].filter(([key]) => key !== 'attachments');
  if (
    entries.length !== allowed.size ||
    entries.some(([k]) => !allowed.has(k)) ||
    [...allowed].some((k) => form.getAll(k).length !== 1)
  )
    throw new UploadError('invalid_request', 'Tepat satu berkas dan satu set metadata diperlukan.');
  const file = form.get('file');
  if (!(file instanceof File))
    throw new UploadError('invalid_request', 'Field file harus berupa berkas.');
  for (const [key, value] of entries)
    if (key !== 'file' && (typeof value !== 'string' || value.length > 4096))
      throw new UploadError('invalid_metadata', 'Metadata terlalu besar atau bukan teks.');
  let labels: unknown;
  try {
    labels = JSON.parse(String(form.get('labels')));
  } catch {
    throw new UploadError('invalid_metadata', 'Daftar label tidak valid.');
  }
  const metadata = parseDraftMetadata({
    title: form.get('title'),
    summary: form.get('summary'),
    categoryId: form.get('categoryId'),
    classification: form.get('classification'),
    labels,
    synthetic: form.get('synthetic') === 'true',
    ...(form.has('documentId')
      ? { documentId: form.get('documentId'), baseVersionId: form.get('baseVersionId') }
      : {}),
  });
  const extra = attachments as File[];
  if (
    [file, ...extra].some((f) => f.size > UPLOAD_LIMITS.binaryBytes) ||
    [file, ...extra].reduce((n, f) => n + f.size, 0) > UPLOAD_LIMITS.totalBytes
  )
    throw new BodyLimitError('Maksimal 50 MiB per berkas dan 100 MiB total.');
  return {
    requestId,
    metadata,
    name: file.name,
    mime: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
    attachments: await Promise.all(
      extra.map(async (a) => ({
        name: a.name,
        mime: a.type,
        bytes: new Uint8Array(await a.arrayBuffer()),
      })),
    ),
  };
}
