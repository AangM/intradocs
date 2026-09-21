import 'server-only';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { getPool } from '@intradocs/db';
import { loadActor } from '@intradocs/db/queries';
import { readRuntimeConfig } from '@intradocs/core/config';
/** The one provider id the login page and the callback URL agree on. */
export const SSO_PROVIDER_ID = 'sso';
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
    // SSO proves who is at the keyboard; it never creates anyone. An IdP subject is
    // attached to the invited account whose (verified) email it carries, and a subject
    // whose email nobody invited is turned away at the callback.
    account: {
      accountLinking: { enabled: true, trustedProviders: c.sso ? [SSO_PROVIDER_ID] : [] },
    },
    plugins: c.sso
      ? [
          genericOAuth({
            config: [
              {
                providerId: SSO_PROVIDER_ID,
                name: c.sso.label,
                discoveryUrl: `${c.sso.issuer}/.well-known/openid-configuration`,
                clientId: c.sso.clientId,
                clientSecret: c.sso.clientSecret,
                scopes: ['openid', 'email', 'profile'],
                pkce: true,
                disableSignUp: true,
                disableImplicitSignUp: true,
                // The IdP's directory is not the portal's: name and unit stay what the
                // admin set when inviting.
                overrideUserInfo: false,
                // An id_token the discovery JWKS cannot verify is not an identity.
                requireIdTokenVerification: true,
              },
            ],
          }),
        ]
      : [],
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
let ssoReady = false;
export function getAuth() {
  return (instance ??= createAuth());
}
/**
 * Better Auth reads the IdP's discovery document once, when the instance first runs,
 * and keeps a failure for the life of the process: an IdP that was down at the portal's
 * first request would stay "unavailable" until a restart. The SSO endpoints go through
 * here instead: the IdP is probed first, and the instance that answered before the IdP
 * was reachable is replaced by a fresh one (sessions live in the database, so nothing is
 * lost). Until the IdP answers, the caller gets a retryable error, not a dead provider.
 * Password sign-in and session reads never wait on this.
 */
export async function getAuthForSso() {
  if (!ssoReady) {
    const c = readRuntimeConfig(process.env);
    if (!c.sso) throw new SsoUnavailable('SSO tidak dikonfigurasi.');
    const r = await fetch(`${c.sso.issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!r?.ok) throw new SsoUnavailable('Penyedia identitas (IdP) tidak dapat dihubungi.');
    instance = createAuth();
    ssoReady = true;
  }
  return getAuth();
}
export class SsoUnavailable extends Error {}
