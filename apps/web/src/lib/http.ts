import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { InputError } from '@intradocs/core/validation';
import { WorkflowError } from '@intradocs/core/workflow';
import { UploadError } from '@intradocs/core/uploads';
import { BodyLimitError } from '@intradocs/core/http-input';
import { AccessDenied } from '@intradocs/db/queries';
import { Unauthenticated } from './session';
export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
export function apiError(error: unknown): NextResponse {
  let status = 503,
    message = 'Layanan belum tersedia. Periksa layanan lokal.';
  if (error instanceof WorkflowError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: PRIVATE_HEADERS },
    );
  if (error instanceof UploadError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      {
        status: error.status,
        headers: {
          ...PRIVATE_HEADERS,
          ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
        },
      },
    );
  } else if (error instanceof BodyLimitError) {
    status = 413;
    message = error.message;
  } else if (error instanceof InputError) {
    status = 400;
    message = error.message;
  } else if (error instanceof Unauthenticated) {
    status = 401;
    message = 'Silakan masuk.';
  } else if (error instanceof AccessDenied) {
    status = 403;
    message = 'Akses ditolak.';
  } else if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['P0002', '42501', '40001', '23505', '23514', '23503', '22P02'].includes(String(error.code))
  ) {
    const code = String(error.code);
    status = ['P0002', '42501'].includes(code)
      ? 404
      : ['40001', '23505'].includes(code)
        ? 409
        : 422;
    message =
      status === 404
        ? 'Dokumen tidak tersedia.'
        : status === 409
          ? 'Dokumen telah berubah. Muat ulang sebelum mencoba lagi.'
          : 'Perubahan tidak sesuai aturan dokumen.';
  } else {
    console.error('Request failed', { requestId: randomUUID() });
  }
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_HEADERS });
}
