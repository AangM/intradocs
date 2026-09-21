import { toNextJsHandler } from 'better-auth/next-js';
import { NextResponse } from 'next/server';
import { SsoUnavailable, getAuth, getAuthForSso } from '@/lib/auth';
import { readBoundedText, parseLoginBody } from '@intradocs/core/http-input';
import { InputError, assertSameOrigin, safeReturnTo } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
export const runtime = 'nodejs';
/**
 * The SSO start body, rebuilt rather than forwarded: one provider, a return path that
 * stays on this origin, and the fixed error page. Nothing the client sends reaches the
 * IdP request except the destination it wants to come back to.
 */
function parseSsoStart(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text || '{}');
  } catch {
    raw = {};
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.provider !== 'sso') throw new InputError('Provider tidak dikenal.');
  // No idToken: a token the browser hands over is never an identity here, only the
  // code the IdP sends to the callback is.
  return {
    provider: 'sso',
    callbackURL: safeReturnTo(typeof o.callbackURL === 'string' ? o.callbackURL : ''),
    errorCallbackURL: '/login?sso=gagal',
    disableRedirect: true,
  };
}
async function handle(request: Request) {
  try {
    const config = readRuntimeConfig(process.env);
    const endpoint = new URL(request.url).pathname.replace(/^\/api\/auth/, '');
    // Only the endpoints this portal uses exist; everything else Better Auth could
    // answer (sign-up, password reset, account listing) is 404 here. The two SSO
    // endpoints appear only when an IdP is configured.
    const gets = ['/get-session', ...(config.sso ? ['/callback/sso'] : [])];
    const posts = ['/sign-in/email', '/sign-out', ...(config.sso ? ['/sign-in/social'] : [])];
    if (
      (request.method === 'GET' && !gets.includes(endpoint)) ||
      (request.method === 'POST' && !posts.includes(endpoint))
    )
      return NextResponse.json(
        { error: 'Endpoint tidak tersedia.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    if (request.method === 'POST') assertSameOrigin(request.headers.get('origin'), config.appUrl);
    // Local server binds to loopback. Do not trust arbitrary proxy headers from the client.
    // Production proxy/IP trust must be implemented together with the production profile.
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-for', '127.0.0.1');
    headers.set('x-real-ip', '127.0.0.1');
    let body: string | undefined;
    if (request.method === 'POST') {
      const text = await readBoundedText(request, 4096);
      body =
        endpoint === '/sign-in/email'
          ? JSON.stringify(parseLoginBody(text))
          : endpoint === '/sign-in/social'
            ? JSON.stringify(parseSsoStart(text))
            : '{}';
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
    }
    const safeRequest = new Request(request.url, { method: request.method, headers, body });
    const sso = endpoint === '/sign-in/social' || endpoint === '/callback/sso';
    const handlers = toNextJsHandler(sso ? await getAuthForSso() : getAuth());
    const response =
      request.method === 'GET' ? await handlers.GET(safeRequest) : await handlers.POST(safeRequest);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (e) {
    if (e instanceof SsoUnavailable)
      return NextResponse.json({ error: e.message }, { status: 503, headers: PRIVATE_HEADERS });
    return apiError(e);
  }
}
export const GET = handle;
export const POST = handle;
