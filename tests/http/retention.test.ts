/**
 * POST /api/versions/:id/reaffirm over HTTP: the owner of a document whose review is
 * near moves the date with an empty body; a viewer has no such endpoint; a body with
 * anything in it, or a version that is not due, is refused with the right status.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS, docId } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const cookies = new Map<string, string>();
const doc = docId(2);
let versionId = '';

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
  assert.equal(r.status, 200);
  cookies.set(
    id,
    r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  );
}
const reaffirm = (actor: string, id: string, body = '{}') =>
  fetch(`${base}/api/versions/${id}/reaffirm`, {
    method: 'POST',
    headers: { Cookie: cookies.get(actor) ?? '', Origin: base, 'Content-Type': 'application/json' },
    body,
  });

before(async () => {
  for (const id of [IDS.contributor, IDS.viewer, IDS.admin]) await login(id);
  versionId = (
    await db.query('SELECT current_version_id AS v FROM app.documents WHERE id=$1', [doc])
  ).rows[0].v;
  await db.query(
    "UPDATE app.document_versions SET review_at=now()+interval '10 days' WHERE id=$1",
    [versionId],
  );
});
after(async () => {
  await db.query("UPDATE app.document_versions SET review_at='2027-02-10T00:00:00Z' WHERE id=$1", [
    versionId,
  ]);
  await db.query(
    "DELETE FROM app.audit_events WHERE action='document.reaffirmed' AND document_id=$1",
    [doc],
  );
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('a viewer cannot reach the endpoint at all', async () => {
  assert.equal((await reaffirm(IDS.viewer, versionId)).status, 403);
});

test('an administrator who does not own the document gets a 404, not a hint', async () => {
  assert.equal((await reaffirm(IDS.admin, versionId)).status, 404);
});

test('a body with fields, or a non-JSON body, is refused', async () => {
  assert.equal((await reaffirm(IDS.contributor, versionId, '{"note":"x"}')).status, 400);
  assert.equal((await reaffirm(IDS.contributor, versionId, 'nope')).status, 400);
});

test('the owner reaffirms: the new date comes back, the audit trail has it, and a second try is not due', async () => {
  const r = await reaffirm(IDS.contributor, versionId);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const { reviewAt } = JSON.parse(text) as { reviewAt: string };
  assert(Date.parse(reviewAt) > Date.now() + 100 * 86_400_000, `moved to ${reviewAt}`);
  const audit = await db.query(
    "SELECT count(*)::int AS n FROM app.audit_events WHERE action='document.reaffirmed' AND document_id=$1 AND actor_id=$2",
    [doc, IDS.contributor],
  );
  assert.equal(audit.rows[0].n, 1);
  assert.equal((await reaffirm(IDS.contributor, versionId)).status, 422);
});
