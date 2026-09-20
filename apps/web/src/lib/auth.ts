import 'server-only';
import { betterAuth } from 'better-auth';
import { getPool } from '@intradocs/db';
import { loadActor } from '@intradocs/db/queries';
import { readRuntimeConfig } from '@intradocs/core/config';
function createAuth() {
  const c = readRuntimeConfig(process.env);
  const appUrl = new URL(c.appUrl);
  // The loopback aliases are a local-dev convenience (the demo is reached as both
  // localhost and 127.0.0.1); a deployment trusts exactly one origin.
  const loopbackOrigins = c.hardened
    ? []
    : ['localhost', '127.0.0.1', '[::1]'].map(
        (host) => `${appUrl.protocol}//${host}:${appUrl.port}`,
      );
  return betterAuth({
    appName: 'IntraDocs Local',
    baseURL: c.appUrl,
    basePath: '/api/auth',
    secret: c.authSecret,
    trustedOrigins: [c.appUrl, ...loopbackOrigins],
    database: getPool('auth'),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    session: { expiresIn: 60 * 60 * 8, updateAge: 60 * 15, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    // Secure cookies wherever the origin is https, which a hardened profile guarantees.
    advanced: { useSecureCookies: c.hardened },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const actor = await loadActor(session.userId);
            return actor ? { data: session } : false;
          },
        },
      },
    },
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}
