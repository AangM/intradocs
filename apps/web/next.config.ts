import type { NextConfig } from 'next';
// HSTS is not set here: headers() is evaluated at build time and the image is built
// without a profile. src/proxy.ts adds it per request when the running profile is
// hardened -- a local demo must never send it (it would pin the browser to https on
// localhost and break every other local project on that host).
const config: NextConfig = {
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  poweredByHeader: false,
  // The floating dev badge sits over the sidebar footer in demos run with `pnpm dev`.
  devIndicators: false,
  transpilePackages: ['@intradocs/core', '@intradocs/db'],
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'" +
              (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') +
              "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};
export default config;
