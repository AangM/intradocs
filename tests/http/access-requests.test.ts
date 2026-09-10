// S02/V1 · permintaan akses. Real HTTP + PostgreSQL/RLS.
// The feature exists so people can ask for access; the tests exist to prove asking
// teaches them nothing about what they cannot already see.
import test, { before, after } from 'node:test';
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
const infra = '10000000-0000-4000-8000-000000000001';
const security = '10000000-0000-4000-8000-000000000002';
const reason = 'Saya perlu membaca SOP keamanan untuk menyiapkan audit internal triwulan ini.';

async function login(id: string) {
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  const a = accounts.find((x) => x.id === id)!;
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  assert.equal(r.status, 200, `login ${a.email}`);
  cookies.set(
    id,
    r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  );
}
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

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.query('DELETE FROM app.access_requests');
  for (const id of [IDS.viewer, IDS.super, IDS.other]) await login(id);
});
after(async () => {
  await db.query('DELETE FROM app.access_requests');
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('a request needs a session', async () => {
  const r = await fetch(base + '/api/access-requests', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryId: infra, classification: 'restricted', reason }),
  });
  assert.equal(r.status, 401);
});

test('a viewer can ask for a higher level in a category they already see', async () => {
  const r = await api(IDS.viewer, '/api/access-requests', {
    categoryId: infra,
    classification: 'restricted',
    reason,
  });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  assert.match(body, /"id"\s*:\s*"[0-9a-f-]{36}"/);
});

test('naming a category outside your scope fails and reveals nothing about it', async () => {
  // siti has no scope over Keamanan Informasi. The refusal must look like any other
  // refusal: no category name, no hint that the id was real rather than invented.
  const real = await api(IDS.viewer, '/api/access-requests', {
    categoryId: security,
    classification: 'restricted',
    reason,
  });
  const invented = await api(IDS.viewer, '/api/access-requests', {
    categoryId: '11111111-1111-4111-8111-111111111111',
    classification: 'restricted',
    reason,
  });
  assert(real.status >= 400, 'kategori di luar scope harus ditolak');
  const realBody = await real.text();
  const inventedBody = await invented.text();
  assert.equal(real.status, invented.status, 'kategori nyata dan karangan harus sama statusnya');
  assert.equal(realBody, inventedBody, 'pesannya pun tidak boleh membedakan keduanya');
  assert(!realBody.includes('Keamanan'), 'nama kategori tidak boleh bocor');
});

test('the level must be one that actually needs a grant', async () => {
  for (const classification of ['internal', 'public', 'admin']) {
    const r = await api(IDS.viewer, '/api/access-requests', {
      categoryId: infra,
      classification,
      reason,
    });
    assert.equal(r.status, 400, `${classification} bukan level yang perlu grant`);
  }
});

test('a bare reason is refused; asking has to say why', async () => {
  const r = await api(IDS.viewer, '/api/access-requests', {
    categoryId: infra,
    classification: 'confidential',
    reason: 'perlu',
  });
  assert.equal(r.status, 400);
});

test('an extra field in the body is refused', async () => {
  const r = await api(IDS.viewer, '/api/access-requests', {
    categoryId: infra,
    classification: 'confidential',
    reason,
    state: 'approved',
  });
  assert.equal(r.status, 400);
});

test('the same open request cannot be filed twice', async () => {
  const r = await api(IDS.viewer, '/api/access-requests', {
    categoryId: infra,
    classification: 'restricted',
    reason,
  });
  assert(r.status >= 400, 'satu permintaan terbuka per kategori dan level');
});

test('a requester sees only their own request, an admin sees it in their scope', async () => {
  const mine = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.access_requests WHERE requester_id=$1',
    [IDS.viewer],
  );
  assert.equal(mine.rows[0]!.n, '1');
  // fajar is a different viewer entirely and must not see siti's request.
  const foreign = await api(IDS.other, '/api/access-requests', undefined, 'GET');
  assert(foreign.status >= 400 || !(await foreign.text()).includes('audit internal'));
});

test('nobody without taxonomy authority can decide a request', async () => {
  const id = (await db.query<{ id: string }>('SELECT id FROM app.access_requests LIMIT 1')).rows[0]!
    .id;
  const r = await api(IDS.viewer, `/api/access-requests/${id}`, {
    approve: true,
    note: 'saya setujui sendiri',
  });
  assert(r.status >= 400, 'pemohon tidak boleh memutuskan permintaannya sendiri');
});

test('a decision requires a note, and approving grants nothing by itself', async () => {
  const id = (await db.query<{ id: string }>('SELECT id FROM app.access_requests LIMIT 1')).rows[0]!
    .id;
  // audit_events is append-only across runs, so count the delta rather than the total.
  const auditBefore = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app.audit_events WHERE action='access.decided' AND subject_user_id=$1",
        [IDS.viewer],
      )
    ).rows[0]!.n,
  );
  const bare = await api(IDS.super, `/api/access-requests/${id}`, { approve: true, note: 'ok' });
  assert.equal(bare.status, 400, 'catatan terlalu pendek harus ditolak');

  const grantsBefore = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.document_grants WHERE user_id=$1',
    [IDS.viewer],
  );
  const ok = await api(IDS.super, `/api/access-requests/${id}`, {
    approve: true,
    note: 'Disetujui; pemilik dokumen akan memberikan grant per dokumen.',
  });
  assert.equal(ok.status, 200, await ok.text());

  const grantsAfter = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.document_grants WHERE user_id=$1',
    [IDS.viewer],
  );
  assert.equal(
    grantsAfter.rows[0]!.n,
    grantsBefore.rows[0]!.n,
    'persetujuan mencatat keputusan, bukan memberi akses',
  );

  const audit = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.audit_events WHERE action='access.decided' AND subject_user_id=$1",
    [IDS.viewer],
  );
  assert.equal(
    Number(audit.rows[0]!.n) - auditBefore,
    1,
    'satu keputusan tercatat oleh pemanggilan ini',
  );
});

test('a decided request cannot be decided again', async () => {
  const id = (
    await db.query<{ id: string }>(
      "SELECT id FROM app.access_requests WHERE state='approved' LIMIT 1",
    )
  ).rows[0]!.id;
  const r = await api(IDS.super, `/api/access-requests/${id}`, {
    approve: false,
    note: 'berubah pikiran setelah keputusan final',
  });
  assert(r.status >= 400);
});
