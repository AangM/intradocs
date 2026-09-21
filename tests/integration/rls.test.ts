// Requires the real local PostgreSQL instance. No mocked DB or RLS substitute.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { getPool, withActor, closePools } from '../../packages/db/src/index.ts';
import {
  loadActor,
  listDocuments,
  listCategories,
  setUserActive,
  readVersionFile,
} from '../../packages/db/src/queries.ts';
import { IDS, docId, versionId } from '../../fixtures/data.ts';
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const published = { q: '', category: null, page: 1, status: 'published', sort: 'updated' } as const;
async function visible(user: string, id: string) {
  return withActor(
    user,
    async ({ client }) =>
      (await client.query('SELECT id FROM app.documents WHERE id=$1', [id])).rowCount === 1,
  );
}
before(async () => {
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM app.profiles')).rows[0].n,
    7,
    'Run pnpm setup:local first',
  );
});
after(async () => {
  await admin.query('UPDATE app.profiles SET active=true WHERE id=$1', [IDS.viewer]);
  await closePools();
  await admin.end();
});
test('application role is neither table owner, superuser nor BYPASSRLS', async () => {
  const { rows } = await getPool().query(
    `SELECT r.rolname,r.rolsuper,r.rolbypassrls,c.relrowsecurity,c.relforcerowsecurity,(c.relowner=r.oid) AS is_owner FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname=current_user AND n.nspname='app' AND c.relname='documents'`,
  );
  assert.equal(rows[0].rolname, 'intradocs_app');
  for (const k of ['rolsuper', 'rolbypassrls', 'is_owner']) assert.equal(rows[0][k], false);
  assert.equal(rows[0].relrowsecurity, true);
  assert.equal(rows[0].relforcerowsecurity, true);
});
test('policy role is NOLOGIN; application cannot SET ROLE into it', async () => {
  const r = await admin.query(
    "SELECT rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname='intradocs_policy'",
  );
  assert.equal(r.rows[0].rolcanlogin, false);
  assert.equal(r.rows[0].rolbypassrls, true);
  await assert.rejects(getPool().query('SET ROLE intradocs_policy'));
});
test('unscoped query sees no documents or profiles', async () => {
  assert.equal((await getPool().query('SELECT * FROM app.documents')).rowCount, 0);
  assert.equal((await getPool().query('SELECT * FROM app.profiles')).rowCount, 0);
});
test('transaction-local actor does not leak through pooled connections', async () => {
  await withActor(IDS.super, async ({ client }) => {
    assert((await client.query('SELECT id FROM app.documents')).rowCount! > 0);
  });
  assert.equal((await getPool().query('SELECT id FROM app.documents')).rowCount, 0);
});
test('viewer can read in-scope internal document, not another unit or sensitive documents', async () => {
  assert(await visible(IDS.viewer, docId(1)));
  assert(!(await visible(IDS.other, docId(1))));
  assert(!(await visible(IDS.viewer, docId(6))));
  assert(!(await visible(IDS.viewer, docId(7))));
});
test('super admin has no blanket sensitive-data access', async () => {
  assert(!(await visible(IDS.super, docId(6))));
  assert(!(await visible(IDS.super, docId(7))));
});
test('explicit sensitive grant works within role and category scope', async () => {
  assert(await visible(IDS.reviewer, docId(6)));
  assert(await visible(IDS.admin, docId(7)));
});
test('private draft requires owner or actual assignment, not generic admin role', async () => {
  assert(await visible(IDS.contributor, docId(8)));
  assert(await visible(IDS.super, docId(8)));
  assert(!(await visible(IDS.admin, docId(8))));
  assert(!(await visible(IDS.viewer, docId(8))));
});
test('withdrawal and expiry are excluded from default discovery', async () => {
  assert(!(await visible(IDS.viewer, docId(9))));
  const d = await listDocuments(IDS.viewer, published);
  assert(!d.items.some((d) => [docId(9), docId(10)].includes(d.id)));
});
test('scope applies to counts, not only document bodies', async () => {
  // The fixture gives siti three published documents; `pnpm demo:content` may add more
  // in her two categories, so the invariant is stated as one: every count the listing
  // shows is the same scoped count, never the table's.
  const data = await listDocuments(IDS.viewer, published);
  assert(data.total >= 3, `siti sees at least the fixture's three, saw ${data.total}`);
  const cats = await listCategories(IDS.viewer);
  assert.equal(cats.length, 2);
  assert.equal(
    cats.reduce((s, c) => s + c.documentCount, 0),
    data.total,
  );
});
test('explicit grant does not bypass viewer ceiling or category scope', async () => {
  try {
    await admin.query('INSERT INTO app.document_grants(document_id,user_id) VALUES($1,$2)', [
      docId(6),
      IDS.viewer,
    ]);
    assert(!(await visible(IDS.viewer, docId(6))));
  } finally {
    await admin.query('DELETE FROM app.document_grants WHERE document_id=$1 AND user_id=$2', [
      docId(6),
      IDS.viewer,
    ]);
  }
});
test('download authorization is on the immutable version ID', async () => {
  assert.equal(await readVersionFile(IDS.viewer, versionId(7)), null);
  assert((await readVersionFile(IDS.viewer, versionId(1)))?.key.endsWith('/content.md'));
});
test('search text cannot widen RLS via SQL injection', async () => {
  const d = await listDocuments(IDS.viewer, { ...published, q: "' OR 1=1 --" });
  assert.equal(d.total, 0);
});
test('app cannot mutate role, publish documents or read password hashes', async () => {
  await assert.rejects(
    withActor(IDS.super, async ({ client }) =>
      client.query("UPDATE app.profiles SET role='super_admin' WHERE id=$1", [IDS.viewer]),
    ),
  );
  await assert.rejects(getPool().query('SELECT password FROM auth.account'));
  await assert.rejects(
    withActor(IDS.super, async ({ client }) =>
      client.query('UPDATE app.documents SET current_version_id=NULL'),
    ),
  );
});
test('deactivation immediately removes data access; self-deactivation is rejected', async () => {
  const actor = await loadActor(IDS.super);
  assert(actor);
  try {
    await setUserActive(actor, IDS.viewer, false);
    assert.equal(await loadActor(IDS.viewer), null);
    assert(!(await visible(IDS.viewer, docId(1))));
    await assert.rejects(setUserActive(actor, IDS.super, false));
  } finally {
    await admin.query('UPDATE app.profiles SET active=true WHERE id=$1', [IDS.viewer]);
  }
});
test('audit events append but cannot be edited by application role', async () => {
  await assert.rejects(
    withActor(IDS.super, async ({ client }) => client.query('DELETE FROM app.audit_events')),
  );
});

test('revoking an explicit grant affects the next database request', async () => {
  try {
    await admin.query('DELETE FROM app.document_grants WHERE document_id=$1 AND user_id=$2', [
      docId(7),
      IDS.admin,
    ]);
    assert(!(await visible(IDS.admin, docId(7))));
  } finally {
    await admin.query(
      'INSERT INTO app.document_grants(document_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [docId(7), IDS.admin],
    );
  }
});
test('concurrent admins cannot deactivate the final active administrator', async () => {
  try {
    await admin.query("UPDATE app.profiles SET role='super_admin',active=true WHERE id=$1", [
      IDS.viewer,
    ]);
    const first = await loadActor(IDS.super),
      second = await loadActor(IDS.viewer);
    assert(first);
    assert(second);
    const results = await Promise.allSettled([
      setUserActive(first, IDS.viewer, false),
      setUserActive(second, IDS.super, false),
    ]);
    assert(results.some((r) => r.status === 'rejected'));
    const count = await admin.query(
      "SELECT count(*)::int AS n FROM app.profiles WHERE role='super_admin' AND active",
    );
    assert.equal(count.rows[0].n, 1);
  } finally {
    await admin.query("UPDATE app.profiles SET role='viewer',active=true WHERE id=$1", [
      IDS.viewer,
    ]);
    await admin.query('UPDATE app.profiles SET active=true WHERE id=$1', [IDS.super]);
  }
});
test('worker credentials cannot read business documents or auth accounts', async () => {
  const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 1 });
  try {
    await assert.rejects(worker.query('SELECT * FROM app.documents'));
    await assert.rejects(worker.query('SELECT * FROM auth.account'));
  } finally {
    await worker.end();
  }
});
