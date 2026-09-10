import { toNextJsHandler } from 'better-auth/next-js';
import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/auth';
import { readBoundedText, parseLoginBody } from '@intradocs/core/http-input';
import { assertSameOrigin } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
export const runtime = 'nodejs';
async function handle(request: Request) {
  try {
    const config = readRuntimeConfig(process.env);
    const endpoint = new URL(request.url).pathname.replace(/^\/api\/auth/, '');
    if (
      (request.method === 'GET' && endpoint !== '/get-session') ||
      (request.method === 'POST' && !['/sign-in/email', '/sign-out'].includes(endpoint))
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
      body = endpoint === '/sign-in/email' ? JSON.stringify(parseLoginBody(text)) : '{}';
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
    }
    const safeRequest = new Request(request.url, { method: request.method, headers, body });
    const handlers = toNextJsHandler(getAuth());
    const response =
      request.method === 'GET' ? await handlers.GET(safeRequest) : await handlers.POST(safeRequest);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (e) {
    return apiError(e);
  }
}
export const GET = handle;
export const POST = handle;
