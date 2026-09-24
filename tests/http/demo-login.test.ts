/**
 * POST /api/demo/sign-in against the running server. With DEMO_LOGIN off (the default)
 * the endpoint does not exist; with it on, one click is an ordinary email sign-in for a
 * synthetic account, nothing more. Which branch runs depends on how the server was
 * started; both are asserted.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';

// REVIEW_URL: a server whose public origin differs from .env.local (a tunnel for review).
const base = process.env.REVIEW_URL ?? process.env.APP_URL!;
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
after(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});
const click = (email: string, origin = base, extra: Record<string, unknown> = {}) =>
  fetch(base + '/api/demo/sign-in', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, ...extra }),
  });

test('the login page never carries a password, whether or not the list is shown', async () => {
  const html = await (await fetch(base + '/login')).text();
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as Array<{ password: string }>;
  for (const a of accounts)
    assert(!html.includes(a.password), 'a demo password leaked into the page');
});

test('one click signs in as the synthetic account, or the endpoint does not exist', async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  const r = await click('siti@example.test');
  if (r.status === 404) {
    assert.doesNotMatch(await (await fetch(base + '/login')).text(), /Masuk cepat/);
    return;
  }
  assert.equal(r.status, 200, await r.text());
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const me = await (
    await fetch(base + '/api/auth/get-session', { headers: { Cookie: cookie } })
  ).json();
  assert.equal(me?.user?.id, IDS.viewer);
});

test('unknown, real-looking, deactivated, cross-origin and padded requests are refused', async (t) => {
  if ((await click('siti@example.test')).status === 404) return t.skip('DEMO_LOGIN off');
  await db.query('DELETE FROM auth."rateLimit"');
  assert.equal((await click('tamu@example.test')).status, 400, 'not in the seed file');
  assert.equal((await click('ceo@perusahaan.co.id')).status, 400, 'never a real address');
  assert.equal(
    (await click('nonaktif@example.test')).status,
    403,
    'the session hook still refuses',
  );
  assert.equal((await click('siti@example.test', 'https://evil.example')).status, 400);
  assert.equal((await click('siti@example.test', base, { password: 'x' })).status, 400);
});
