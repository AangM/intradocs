import { NextResponse } from 'next/server';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { assertSameOrigin, InputError } from '@intradocs/core/validation';
import { readBoundedText } from '@intradocs/core/http-input';
import { readRuntimeConfig } from '@intradocs/core/config';
import { acceptInvitation } from '@intradocs/db/invitations';

/**
 * The one unauthenticated write in the portal: an invitee sets their password. The
 * token is the only credential; it is single-use, hashed at rest, and expires. The
 * password goes straight to the hasher and is never logged.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
      throw new InputError('Gunakan JSON.');
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(request, 4096));
    } catch {
      throw new InputError('JSON tidak valid.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'password,token')
      throw new InputError('Hanya field token dan password yang diizinkan.');
    if (typeof v.token !== 'string' || typeof v.password !== 'string')
      throw new InputError('Token atau password tidak valid.');
    const result = await acceptInvitation(v.token, v.password);
    return NextResponse.json({ ok: true, email: result.email }, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
