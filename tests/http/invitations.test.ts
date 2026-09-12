// S08/V1 · undangan lokal. Requires pnpm dev and the real seeded local DB.
//
// What is under test is the boundary: who may invite whom, that the token is the only
// way in and works exactly once, that a knowledge admin cannot escalate through it, and
// that the account that results is a normal local account with the scope decided by the
// inviter. Every invitee here is synthetic and removed again at the end.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
let accounts: DemoAccount[];
const stamp = randomBytes(4).toString('hex');
const invitee = `undangan-${stamp}@example.test`;

before(async () => {
  accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  await admin.query('DELETE FROM auth."rateLimit"');
});
after(async () => {
  // Profiles cascade from auth."user"; the audit rows naming the synthetic person as
  // subject and the invitations themselves are removed first.
  await admin.query(
    'DELETE FROM app.audit_events WHERE subject_user_id IN (SELECT id FROM app.profiles WHERE email LIKE $1)',
    [`undangan-${stamp}%`],
  );
  await admin.query('DELETE FROM app.invitations WHERE email LIKE $1', [`undangan-${stamp}%`]);
  await admin.query('DELETE FROM auth."user" WHERE email LIKE $1', [`undangan-${stamp}%`]);
  await admin.query('DELETE FROM auth."rateLimit"');
  await admin.end();
});

const sessions = new Map<string, string>();
async function login(id: string) {
  const cached = sessions.get(id);
  if (cached) return cached;
  const a = accounts.find((x) => x.id === id)!;
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  assert.equal(r.status, 200, 'Real sign-in must succeed');
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  sessions.set(id, cookie);
  return cookie;
}
async function call(method: string, route: string, cookie: string | null, body?: unknown) {
  const r = await fetch(base + route, {
    method,
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const draft = (email: string, extra: Record<string, unknown> = {}) => ({
  name: 'Tamu Sintetis',
  email,
  unit: 'Infrastructure',
  role: 'viewer',
  scopeAll: false,
  categoryIds: [IDS.infra],
  ...extra,
});

test('only administrators may invite, and never a super admin', async () => {
  const viewer = await login(IDS.viewer);
  assert.equal((await call('POST', '/api/invitations', viewer, draft(invitee))).status, 403);
  assert.equal((await call('GET', '/api/invitations', viewer)).status, 403);
  const budi = await login(IDS.super);
  assert.equal(
    (await call('POST', '/api/invitations', budi, draft(invitee, { role: 'super_admin' }))).status,
    400,
  );
  assert.equal(
    (await call('POST', '/api/invitations', budi, draft('siti@example.test'))).status,
    400,
    'an address that already has an account cannot be invited',
  );
});

test('a knowledge admin cannot escalate through an invitation', async () => {
  const andi = await login(IDS.admin); // knowledge_admin, unit IT Governance in the fixture
  const unit = (
    await admin.query<{ unit: string }>('SELECT unit FROM app.profiles WHERE id=$1', [IDS.admin])
  ).rows[0]!.unit;
  const other = `undangan-${stamp}-ka@example.test`;
  // Another unit, a knowledge_admin role, or global scope: all refused in SQL.
  for (const extra of [
    { unit: 'Unit Lain' },
    { role: 'knowledge_admin', unit },
    { scopeAll: true, categoryIds: [], unit },
  ]) {
    const r = await call('POST', '/api/invitations', andi, draft(other, extra));
    assert(r.status >= 400 && r.status < 500, `must be refused: ${JSON.stringify(extra)}`);
  }
});

test('the link works exactly once and yields a normal local account with the decided scope', async () => {
  const budi = await login(IDS.super);
  const created = await call('POST', '/api/invitations', budi, draft(invitee));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const link = created.body.link as string;
  assert.match(link, /\/undangan\/[A-Za-z0-9_-]{40,50}$/);
  const token = link.split('/').pop()!;
  const stored = await admin.query<{ token_hash: string }>(
    'SELECT token_hash FROM app.invitations WHERE email=$1',
    [invitee],
  );
  assert.notEqual(stored.rows[0]!.token_hash, token, 'the token itself is never stored');

  // The public page shows the invitation; a mangled token shows nothing.
  const page = await fetch(base + `/undangan/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Undangan bergabung/);
  const bad = await fetch(base + `/undangan/${token.slice(0, -2)}xx`);
  assert.match(await bad.text(), /tidak berlaku/);

  // A synthetic password for a synthetic account; too short is refused first.
  const password = `Uji-${randomBytes(12).toString('base64url')}`;
  assert.equal(
    (await call('POST', '/api/invitations/accept', null, { token, password: 'pendek' })).status,
    400,
  );
  const accepted = await call('POST', '/api/invitations/accept', null, { token, password });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(
    (await call('POST', '/api/invitations/accept', null, { token, password })).status,
    400,
    'a used token is dead',
  );

  // The new person can sign in and sees exactly the scope that was decided for them.
  const signin = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: invitee, password }),
  });
  assert.equal(signin.status, 200, 'the invited account signs in like any local account');
  const profile = await admin.query<{
    role: string;
    unit: string;
    active: boolean;
    cats: string[];
  }>(
    `SELECT p.role,p.unit,p.active,ARRAY(SELECT category_id::text FROM app.category_grants g WHERE g.user_id=p.id) AS cats
     FROM app.profiles p WHERE p.email=$1`,
    [invitee],
  );
  assert.deepEqual(
    { ...profile.rows[0]!, cats: profile.rows[0]!.cats },
    { role: 'viewer', unit: 'Infrastructure', active: true, cats: [IDS.infra] },
  );
  const listed = await call('GET', '/api/invitations', budi);
  assert(
    (listed.body.invitations as Array<{ email: string; state: string }>).some(
      (i) => i.email === invitee && i.state === 'accepted',
    ),
  );
  const audit = await admin.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.audit_events WHERE action='user.invitation_accepted' AND actor_id=$1",
    [IDS.super],
  );
  assert(Number(audit.rows[0]!.n) >= 1);
});

test('a revoked invitation cannot be accepted', async () => {
  const budi = await login(IDS.super);
  const email = `undangan-${stamp}-cabut@example.test`;
  const created = await call('POST', '/api/invitations', budi, draft(email));
  assert.equal(created.status, 200);
  const token = (created.body.link as string).split('/').pop()!;
  assert.equal((await call('DELETE', `/api/invitations/${created.body.id}`, budi)).status, 200);
  const r = await call('POST', '/api/invitations/accept', null, {
    token,
    password: `Uji-${randomBytes(12).toString('base64url')}`,
  });
  assert.equal(r.status, 400);
  assert.equal(
    (await admin.query('SELECT 1 FROM auth."user" WHERE email=$1', [email])).rowCount,
    0,
  );
});
