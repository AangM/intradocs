/**
 * SSO against the mock IdP (scripts/mock-idp.ts). Runs only when the server under test
 * reports auth=oidc on /api/health, i.e. was started with AUTH_MODE=oidc and
 * OIDC_ISSUER=http://localhost:3099; otherwise every test here is skipped, not failed.
 *
 * What is proven: an invited person signs in through the IdP and gets a real session;
 * the IdP subject is linked to the invited account rather than a new one; an address
 * nobody invited is refused with no session; a deactivated account is refused even
 * though the IdP vouches for it; and the callback rejects a forged state.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { IDS, users } from '../../fixtures/data.ts';
import { demoIdpUsers, startMockIdp } from '../../scripts/mock-idp.ts';

const base = process.env.APP_URL!;
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
let idp: Awaited<ReturnType<typeof startMockIdp>> | null = null;
let enabled = false;

before(async () => {
  // The IdP first: Better Auth runs discovery when the auth instance is first used, and
  // a server whose first request finds no IdP keeps that answer.
  idp = await startMockIdp(3099, await demoIdpUsers()).catch(() => null);
  // Already running from `pnpm idp:mock`? Fine; the test uses whichever answers.
  const health = (await (await fetch(base + '/api/health')).json()) as { auth?: string };
  enabled = health.auth === 'oidc';
  // Links left by a manual run of the demo IdP would make "one link" ambiguous.
  await db.query('DELETE FROM auth.account WHERE "providerId"=\'sso\'');
});
after(async () => {
  await idp?.close();
  await db.query('DELETE FROM auth.account WHERE "providerId"=\'sso\'');
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

const jar = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Walks the whole flow as a browser would, picking `email` on the IdP's page. */
async function signInVia(email: string, returnTo = '/help-center') {
  await db.query('DELETE FROM auth."rateLimit"');
  const start = await fetch(base + '/api/auth/sign-in/social', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'sso',
      callbackURL: returnTo,
      errorCallbackURL: '/login?sso=gagal',
      disableRedirect: true,
    }),
  });
  const startText = await start.text();
  assert.equal(start.status, 200, startText);
  const cookie = jar(start);
  const { url } = JSON.parse(startText) as { url: string };
  const authorize = new URL(url);
  authorize.searchParams.set('as', email);
  const idpHop = await fetch(authorize, { redirect: 'manual' });
  assert.equal(idpHop.status, 302, 'the IdP redirects back with a code');
  const callback = idpHop.headers.get('location')!;
  const done = await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie } });
  return { status: done.status, location: done.headers.get('location') ?? '', cookie: jar(done) };
}
async function whoAmI(cookie: string) {
  const r = await fetch(base + '/api/auth/get-session', { headers: { Cookie: cookie } });
  if (r.status !== 200) return null;
  const body = (await r.json()) as { user?: { id: string; email: string } } | null;
  return body?.user ?? null;
}

test('an invited person signs in through the IdP and lands where they were going', async (t) => {
  if (!enabled) return t.skip('server not started with AUTH_MODE=oidc');
  const siti = users.find((u) => u.id === IDS.viewer)!;
  const r = await signInVia(siti.email, '/katalog');
  assert.equal(r.status, 302, 'callback redirects');
  assert.equal(new URL(r.location, base).pathname, '/katalog');
  const me = await whoAmI(r.cookie);
  assert.equal(me?.id, IDS.viewer, 'the session is the invited account, not a new user');
  // The IdP subject is now attached to that account; no second user appeared.
  const { rows } = await db.query(
    'SELECT "userId","accountId" FROM auth.account WHERE "providerId"=$1',
    ['sso'],
  );
  assert.deepEqual(rows, [{ userId: IDS.viewer, accountId: `mock:${IDS.viewer}` }]);
  const count = await db.query('SELECT count(*)::int AS n FROM auth."user" WHERE email=$1', [
    siti.email,
  ]);
  assert.equal(count.rows[0].n, 1);
});

test('a second sign-in reuses the link, and the portal still decides scope', async (t) => {
  if (!enabled) return t.skip('server not started with AUTH_MODE=oidc');
  const siti = users.find((u) => u.id === IDS.viewer)!;
  const r = await signInVia(siti.email);
  assert.equal((await whoAmI(r.cookie))?.id, IDS.viewer);
  const links = await db.query(
    'SELECT count(*)::int AS n FROM auth.account WHERE "providerId"=$1',
    ['sso'],
  );
  assert.equal(links.rows[0].n, 1, 'one link per subject');
  // Her categories are the portal's, whatever the IdP says about her.
  const docs = await fetch(base + '/api/documents', { headers: { Cookie: r.cookie } });
  assert.equal(docs.status, 200);
  const cats = new Set(
    ((await docs.json()) as { items: Array<{ categoryId: string }> }).items.map(
      (d) => d.categoryId,
    ),
  );
  assert(cats.has(IDS.infra) && !cats.has(IDS.sop), `scope: ${[...cats]}`);
});

test('an address nobody invited is refused: no user, no session', async (t) => {
  if (!enabled) return t.skip('server not started with AUTH_MODE=oidc');
  const r = await signInVia('tamu@example.test');
  assert.equal(r.status, 302);
  const to = new URL(r.location, base);
  assert.equal(to.pathname, '/login', `refused to ${r.location}`);
  assert.equal(await whoAmI(r.cookie), null);
  const made = await db.query('SELECT count(*)::int AS n FROM auth."user" WHERE email=$1', [
    'tamu@example.test',
  ]);
  assert.equal(made.rows[0].n, 0, 'SSO must not create an account');
});

test('a deactivated account cannot get in through the IdP either', async (t) => {
  if (!enabled) return t.skip('server not started with AUTH_MODE=oidc');
  const off = users.find((u) => u.id === IDS.disabled)!;
  const r = await signInVia(off.email);
  assert.equal(await whoAmI(r.cookie), null, 'the session hook refuses an inactive profile');
});

test('a callback with a forged state is refused', async (t) => {
  if (!enabled) return t.skip('server not started with AUTH_MODE=oidc');
  const r = await fetch(base + '/api/auth/callback/sso?code=x&state=forged', {
    redirect: 'manual',
  });
  assert(r.status >= 300, 'never a session from an unknown state');
  assert.equal(jar(r).includes('better-auth.session_token='), false);
});
