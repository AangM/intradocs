import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runtime headers a profile-agnostic image cannot bake in at build time.
 *
 * HSTS tells browsers to refuse plain http for this host for a year. That is exactly
 * right behind a TLS-terminating proxy on a deployment and exactly wrong on a laptop,
 * where it would pin localhost to https for every other project too -- so it follows
 * the running profile, read per request, never the build.
 */
const HARDENED = new Set(['staging', 'production']);

export function proxy(_request: NextRequest) {
  const response = NextResponse.next();
  if (HARDENED.has(process.env.APP_PROFILE ?? ''))
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return response;
}

export const config = {
  // Pages only. Static assets gain nothing from the header, and API routes are reached
  // by same-origin fetches from pages that already carried it -- while routing a 50 MiB
  // multipart upload through the proxy runtime broke its body parsing. The browser's
  // HSTS decision is made on navigations, which this matcher covers.
  matcher: ['/((?!api/|_next/static|_next/image|icons.svg|favicon.ico).*)'],
};
