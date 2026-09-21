// Custom roles (migration 039) through the real app: a super admin defines a role that
// narrows a built-in one, assigns it, and the holder's denied capability is refused on
// the next request -- while the database keeps enforcing the base role. Requires pnpm dev
// and the seeded local DB; every row this file creates is removed again in `after`.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const cookies = new Map<string, string>();
let roleId = '';
let revision = 1;

async function api(actor: string, route: string, body?: unknown, method = 'POST') {
  return fetch(base + route, {
    method,
    headers: {
      Cookie: cookies.get(actor) ?? '',
      Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login(id: string) {
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  await db.query('DELETE FROM auth."rateLimit"');
  const a = accounts.find((a) => a.id === id)!;
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  assert.equal(r.status, 200, 'Real login');
  cookies.set(
    id,
    r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  );
}

before(async () => {
  for (const id of [IDS.super, IDS.admin, IDS.contributor]) await login(id);
  // Rizky (contributor) is the subject: the role under test narrows a contributor.
  await db.query('UPDATE app.profiles SET custom_role_id=NULL WHERE id=$1', [IDS.contributor]);
});
after(async () => {
  // Put Rizky back exactly as the seed has him -- role, no custom role, and his three
  // categories (the assignments above narrow him to one) -- and remove this file's roles.
  await db.query("UPDATE app.profiles SET role='contributor',custom_role_id=NULL WHERE id=$1", [
    IDS.contributor,
  ]);
  await db.query('DELETE FROM app.category_grants WHERE user_id=$1', [IDS.contributor]);
  await db.query(
    'INSERT INTO app.category_grants(user_id,category_id) SELECT $1,x FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING',
    [IDS.contributor, [IDS.infra, IDS.data, IDS.apps]],
  );
  await db.query("DELETE FROM app.custom_roles WHERE name LIKE 'Uji role %'");
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('only a super admin defines a custom role, and only as a subset of its base', async () => {
  const body = {
    name: 'Uji role penulis',
    description: 'Contributor tanpa hak unggah — hanya membaca draft sendiri.',
    color: 'sky',
    baseRole: 'contributor',
    deniedCapabilities: ['documents.upload'],
  };
  // A knowledge admin sees the list but may not define roles: account policy is the
  // super admin's.
  assert.equal((await api(IDS.admin, '/api/roles', body)).status, 403);
  assert.equal((await api(IDS.admin, '/api/roles', undefined, 'GET')).status, 200);
  // Denying something the base never had is refused, not silently stored.
  const beyond = await api(IDS.super, '/api/roles', {
    ...body,
    deniedCapabilities: ['users.manage'],
  });
  assert.equal(beyond.status, 400);
  const created = await api(IDS.super, '/api/roles', body);
  const createdBody = (await created.json()) as { id?: string; error?: string };
  assert.equal(created.status, 200, createdBody.error);
  roleId = createdBody.id!;
  const listed = (await (await api(IDS.super, '/api/roles', undefined, 'GET')).json()) as {
    roles: Array<{ id: string; name: string; baseRole: string; holders: number; revision: number }>;
  };
  const mine = listed.roles.find((r) => r.id === roleId)!;
  assert.equal(mine.baseRole, 'contributor');
  assert.equal(mine.holders, 0);
  revision = mine.revision;
});

test('assigning the role keeps the database role and removes the denied capability', async () => {
  // The custom role must match the built-in role it is assigned with: SQL refuses a
  // viewer holding a contributor-based role (the trigger and assign_user both check).
  const mismatch = await api(IDS.super, `/api/users/${IDS.contributor}/assignment`, {
    role: 'viewer',
    scopeAll: false,
    categoryIds: [IDS.infra, IDS.data, IDS.apps],
    customRoleId: roleId,
  });
  assert.equal(mismatch.status, 422, await mismatch.text());
  const ok = await api(IDS.super, `/api/users/${IDS.contributor}/assignment`, {
    role: 'contributor',
    scopeAll: false,
    categoryIds: [IDS.infra, IDS.data, IDS.apps],
    customRoleId: roleId,
  });
  assert.equal(ok.status, 200, await ok.text());
  const row = await db.query('SELECT role,custom_role_id FROM app.profiles WHERE id=$1', [
    IDS.contributor,
  ]);
  assert.equal(row.rows[0].role, 'contributor', 'the database role is the base role');
  assert.equal(row.rows[0].custom_role_id, roleId);
  // Next request as Rizky: the upload page and API are refused, reading still works.
  assert.equal((await api(IDS.contributor, '/api/documents', undefined, 'GET')).status, 200);
  const drafts = await fetch(base + '/api/documents/drafts', {
    method: 'POST',
    headers: { Cookie: cookies.get(IDS.contributor)!, Origin: base },
    body: new FormData(),
  });
  assert.equal(drafts.status, 403, 'documents.upload is denied by the custom role');
  // The page streams, so the refusal is a client redirect inside a 200 body: the form
  // is absent and the access-denied route is what the browser is sent to.
  const page = await (
    await fetch(base + '/unggah', { headers: { Cookie: cookies.get(IDS.contributor)! } })
  ).text();
  assert(!page.includes('Pilih berkas utama'), 'no upload form for the narrowed role');
  assert.match(page, /akses-ditolak/);
  // The name the holder sees is the custom role's.
  const home = await fetch(base + '/help-center', {
    headers: { Cookie: cookies.get(IDS.contributor)! },
  });
  assert((await home.text()).includes('Uji role penulis'));
});

test('a held role cannot change its base or be archived; editing its denials applies at once', async () => {
  const rebase = await api(
    IDS.super,
    `/api/roles/${roleId}`,
    {
      name: 'Uji role penulis',
      description: '',
      color: 'sky',
      baseRole: 'viewer',
      deniedCapabilities: [],
      revision,
    },
    'PATCH',
  );
  assert.equal(rebase.status, 422, await rebase.text());
  const archive = await api(IDS.super, `/api/roles/${roleId}`, { revision }, 'DELETE');
  assert.equal(archive.status, 422, 'still assigned');
  // Give the capability back by editing the definition: no re-assignment, no re-login.
  const restore = await api(
    IDS.super,
    `/api/roles/${roleId}`,
    {
      name: 'Uji role penulis',
      description: 'Contributor penuh lagi.',
      color: 'sky',
      baseRole: 'contributor',
      deniedCapabilities: [],
      revision,
    },
    'PATCH',
  );
  assert.equal(restore.status, 200, await restore.text());
  revision += 1;
  const page = await (
    await fetch(base + '/unggah', { headers: { Cookie: cookies.get(IDS.contributor)! } })
  ).text();
  assert(page.includes('Pilih berkas utama'), 'documents.upload is back for the holder');
  // A stale revision is a conflict, never a silent overwrite.
  const stale = await api(
    IDS.super,
    `/api/roles/${roleId}`,
    {
      name: 'Uji role penulis',
      description: '',
      color: 'sky',
      baseRole: 'contributor',
      deniedCapabilities: [],
      revision: revision - 1,
    },
    'PATCH',
  );
  assert.equal(stale.status, 409);
});

test('unassigning frees the role; archiving hides it from every list and the audit trail records it', async () => {
  const back = await api(IDS.super, `/api/users/${IDS.contributor}/assignment`, {
    role: 'contributor',
    scopeAll: false,
    categoryIds: [IDS.infra, IDS.data, IDS.apps],
    customRoleId: null,
  });
  assert.equal(back.status, 200, await back.text());
  const archive = await api(IDS.super, `/api/roles/${roleId}`, { revision }, 'DELETE');
  assert.equal(archive.status, 200, await archive.text());
  const listed = (await (await api(IDS.super, '/api/roles', undefined, 'GET')).json()) as {
    roles: Array<{ id: string }>;
  };
  assert(!listed.roles.some((r) => r.id === roleId));
  // The newest three role events are this file's, in order.
  const audit = await db.query(
    "SELECT action FROM app.audit_events WHERE action IN ('role.created','role.updated','role.archived') ORDER BY id DESC LIMIT 3",
  );
  assert.deepEqual(audit.rows.map((r) => r.action).reverse(), [
    'role.created',
    'role.updated',
    'role.archived',
  ]);
});
