import { NextResponse } from 'next/server';
import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth';
import { demoCredential } from '@/lib/demo-accounts';
import { readBoundedText } from '@intradocs/core/http-input';
import { assertSameOrigin, InputError } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
export const runtime = 'nodejs';

/**
 * One-click sign-in as a synthetic demo account. Exists only with DEMO_LOGIN=true (never
 * on production -- the config refuses to start). It does not mint a session itself: it
 * replays the ordinary email sign-in with the password the seed wrote, so the rate
 * limit, the inactive-account hook and the session cookie are exactly a normal login's.
 */
export async function POST(request: Request) {
  try {
    const config = readRuntimeConfig(process.env);
    if (!config.demoLogin)
      return NextResponse.json(
        { error: 'Endpoint tidak tersedia.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    assertSameOrigin(request.headers.get('origin'), config.appUrl);
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(request, 256));
    } catch {
      throw new InputError('JSON tidak valid.');
    }
    const email = (body as { email?: unknown })?.email;
    if (typeof email !== 'string' || Object.keys(body as object).length !== 1)
      throw new InputError('Pilih akun demo.');
    const account = await demoCredential(email);
    if (!account) throw new InputError('Akun demo tidak dikenal.');
    const headers = new Headers({
      'content-type': 'application/json',
      origin: config.appUrl,
      // Same loopback identity the auth route pins, so the rate limit applies alike.
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1',
    });
    const signIn = new Request(new URL('/api/auth/sign-in/email', config.appUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    const response = await toNextJsHandler(getAuth()).POST(signIn);
    const out = NextResponse.json(
      response.ok
        ? { ok: true }
        : { error: 'Akun demo tidak dapat masuk (nonaktif atau dibatasi).' },
      { status: response.ok ? 200 : response.status === 429 ? 429 : 403, headers: PRIVATE_HEADERS },
    );
    for (const cookie of response.headers.getSetCookie()) out.headers.append('Set-Cookie', cookie);
    return out;
  } catch (e) {
    return apiError(e);
  }
}
