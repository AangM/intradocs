/**
 * A tiny OpenID Connect provider for a laptop: discovery, authorization code + PKCE,
 * RS256-signed id_token with a JWKS, and userinfo. It exists so the SSO flow can be run
 * end to end (and tested) without an organisation's IdP, and it knows only the synthetic
 * demo accounts plus one address nobody invited -- the case the portal must refuse.
 *
 *   pnpm idp:mock            # http://localhost:3099, then AUTH_MODE=oidc in .env.local
 *
 * Never point a deployment at this. It authenticates nobody: whoever picks a name on its
 * consent page becomes that person.
 */
import http from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

export interface MockIdpUser {
  sub: string;
  email: string;
  name: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function startMockIdp(
  port: number,
  users: MockIdpUser[],
  { clientId = 'intradocs-local', clientSecret = 'mock-idp-secret-not-for-deployments' } = {},
): Promise<{ issuer: string; close: () => Promise<void> }> {
  const issuer = `http://localhost:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // A fresh key id per start, as a rotating IdP would have: a relying party that cached
  // the previous JWKS sees an unknown kid and fetches again instead of failing.
  const kid = `mock-${randomBytes(4).toString('hex')}`;
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as object),
    kid,
    use: 'sig',
    alg: 'RS256',
  };
  // code -> what was authorised. One use each, ten minutes, like a real one.
  const codes = new Map<
    string,
    { user: MockIdpUser; nonce: string; challenge: string; redirect: string; at: number }
  >();
  const tokens = new Map<string, MockIdpUser>();

  function sign(claims: Record<string, unknown>) {
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64(JSON.stringify(claims));
    const s = createSign('RSA-SHA256');
    s.update(`${head}.${body}`);
    return `${head}.${body}.${b64(s.sign(privateKey))}`;
  }
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration')
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/logout') {
      res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
      return res.end();
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code')
        return json(res, 400, { error: 'invalid_request' });
      const redirect = q.get('redirect_uri') ?? '';
      const state = q.get('state') ?? '';
      const as = q.get('as');
      const user = users.find((u) => u.email === as);
      if (!user) {
        // The consent page: a list of the synthetic people. Picking one is "logging in".
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const links = users
          .map((u) => {
            const next = new URL(url.href);
            next.searchParams.set('as', u.email);
            return `<li><a href="${next.pathname}${next.search}">${u.name} &lt;${u.email}&gt;</a></li>`;
          })
          .join('');
        return res.end(
          `<!doctype html><meta charset="utf-8"><title>IdP tiruan</title><body style="font:15px system-ui;max-width:32rem;margin:4rem auto"><h1>IdP tiruan (lokal)</h1><p>Pilih siapa yang "masuk". Ini bukan autentikasi: hanya untuk demo dan uji di laptop.</p><ul>${links}</ul>`,
        );
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        user,
        nonce: q.get('nonce') ?? '',
        challenge: q.get('code_challenge') ?? '',
        redirect,
        at: Date.now(),
      });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      if (state) back.searchParams.set('state', state);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      let id = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      if (basic) {
        const [bid = '', bsecret = ''] = Buffer.from(basic[1] ?? '', 'base64')
          .toString()
          .split(':');
        id = bid;
        secret = bsecret;
      }
      if (id !== clientId || secret !== clientSecret)
        return json(res, 401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!grant || Date.now() - grant.at > 600_000 || grant.redirect !== form.get('redirect_uri'))
        return json(res, 400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      if (
        grant.challenge &&
        b64(createHash('sha256').update(verifier).digest()) !== grant.challenge
      )
        return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
      const access = randomBytes(24).toString('base64url');
      tokens.set(access, grant.user);
      const now = Math.floor(Date.now() / 1000);
      return json(res, 200, {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid email profile',
        id_token: sign({
          iss: issuer,
          aud: clientId,
          sub: grant.user.sub,
          email: grant.user.email,
          email_verified: true,
          name: grant.user.name,
          nonce: grant.nonce || undefined,
          iat: now,
          exp: now + 300,
        }),
      });
    }
    if (url.pathname === '/userinfo') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      const user = m && tokens.get(m[1] ?? '');
      if (!user) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, {
        sub: user.sub,
        email: user.email,
        email_verified: true,
        name: user.name,
      });
    }
    json(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () =>
      resolve({
        issuer,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

/** The people the mock knows: the demo fixture, plus one address nobody invited. */
export async function demoIdpUsers(): Promise<MockIdpUser[]> {
  const { users } = await import('../fixtures/data.ts');
  return [
    ...users.map((a) => ({ sub: `mock:${a.id}`, email: a.email, name: a.name })),
    { sub: 'mock:uninvited', email: 'tamu@example.test', name: 'Tamu Tanpa Undangan' },
  ];
}

if (process.argv[1] && /mock-idp\.ts$/.test(process.argv[1])) {
  const port = Number(process.env.MOCK_IDP_PORT ?? 3099);
  const { issuer } = await startMockIdp(port, await demoIdpUsers());
  console.log(
    `IdP tiruan di ${issuer}\n` +
      `  OIDC_ISSUER=${issuer}\n  OIDC_CLIENT_ID=intradocs-local\n  OIDC_CLIENT_SECRET=mock-idp-secret-not-for-deployments\n  AUTH_MODE=oidc`,
  );
}
