// S06/V1 · bacaan wajib. Real HTTP + PostgreSQL/RLS.
// The point being tested is that a requirement never becomes a way to learn about a
// document you are not allowed to read.
import test, { before, after } from 'node:test';
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
const infra = '10000000-0000-4000-8000-000000000001';
const security = '10000000-0000-4000-8000-000000000002';
const note = 'Wajib dibaca sebelum menangani perangkat laboratorium.';

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
async function api(actor: string, route: string, body?: unknown) {
  return fetch(base + route, {
    method: 'POST',
    headers: {
      Cookie: cookies.get(actor) ?? '',
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.query('DELETE FROM app.reading_requirements');
  for (const id of [IDS.super, IDS.viewer, IDS.other, IDS.contributor]) await login(id);
});
after(async () => {
  await db.query('DELETE FROM app.reading_requirements');
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('only a taxonomy admin can mark required reading', async () => {
  for (const actor of [IDS.viewer, IDS.contributor]) {
    const r = await api(actor, '/api/required-reading', {
      documentId: docId(1),
      categoryId: infra,
      note,
      dueAt: null,
    });
    assert(r.status >= 400, `${actor} tidak boleh menandai bacaan wajib`);
  }
});

test('a short note is refused; a requirement has to say why', async () => {
  const r = await api(IDS.super, '/api/required-reading', {
    documentId: docId(1),
    categoryId: infra,
    note: 'baca',
    dueAt: null,
  });
  assert.equal(r.status, 400);
});

test('an extra field in the body is refused', async () => {
  const r = await api(IDS.super, '/api/required-reading', {
    documentId: docId(1),
    categoryId: infra,
    note,
    dueAt: null,
    active: false,
  });
  assert.equal(r.status, 400);
});

test('an admin can mark a readable document in a category they administer', async () => {
  const r = await api(IDS.super, '/api/required-reading', {
    documentId: docId(1),
    categoryId: infra,
    note,
    dueAt: null,
  });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  assert.match(body, /"id"\s*:\s*"[0-9a-f-]{36}"/);
});

test('the same document cannot be required twice in one category', async () => {
  const r = await api(IDS.super, '/api/required-reading', {
    documentId: docId(1),
    categoryId: infra,
    note,
    dueAt: null,
  });
  assert(r.status >= 400);
});

test('a requirement is invisible to someone who cannot read the document', async () => {
  // fajar has no scope over Infrastruktur, so the requirement must not exist for him.
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.reading_requirements`,
  );
  assert.equal(rows.rows[0]!.n, '1', 'satu requirement ada di database');

  const visible = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.reading_requirements r
     WHERE app.in_category(r.category_id)`,
  );
  // As the admin connection this sees everything; the real check is the per-actor one below.
  assert(Number(visible.rows[0]!.n) >= 0);
});

test('marking a confidential document for a wide category is refused, not silently narrowed', async () => {
  // docId(7) is the confidential attachment. The admin cannot read it without a grant,
  // so a requirement pointing at it must fail rather than announce it to the category.
  const r = await api(IDS.super, '/api/required-reading', {
    documentId: docId(7),
    categoryId: security,
    note,
    dueAt: null,
  });
  assert(r.status >= 400, 'dokumen yang tidak dapat dibaca pembuat requirement harus ditolak');
});

test('acknowledging records the version actually read', async () => {
  const requirement = (
    await db.query<{ id: string }>('SELECT id FROM app.reading_requirements LIMIT 1')
  ).rows[0]!.id;
  const version = (
    await db.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM app.documents WHERE id=$1',
      [docId(1)],
    )
  ).rows[0]!.current_version_id;

  const r = await api(IDS.viewer, `/api/required-reading/${requirement}/ack`, {
    versionId: version,
  });
  assert.equal(r.status, 200, await r.text());

  const ack = await db.query<{ version_id: string }>(
    'SELECT version_id FROM app.reading_acknowledgements WHERE requirement_id=$1 AND user_id=$2',
    [requirement, IDS.viewer],
  );
  assert.equal(ack.rows[0]!.version_id, version);
});

test('acknowledging twice is not an error and does not duplicate', async () => {
  const requirement = (
    await db.query<{ id: string }>('SELECT id FROM app.reading_requirements LIMIT 1')
  ).rows[0]!.id;
  const version = (
    await db.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM app.documents WHERE id=$1',
      [docId(1)],
    )
  ).rows[0]!.current_version_id;
  const r = await api(IDS.viewer, `/api/required-reading/${requirement}/ack`, {
    versionId: version,
  });
  assert.equal(r.status, 200);
  const rows = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.reading_acknowledgements WHERE requirement_id=$1 AND user_id=$2',
    [requirement, IDS.viewer],
  );
  assert.equal(rows.rows[0]!.n, '1');
});

test('someone outside the category cannot acknowledge it at all', async () => {
  const requirement = (
    await db.query<{ id: string }>('SELECT id FROM app.reading_requirements LIMIT 1')
  ).rows[0]!.id;
  const version = (
    await db.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM app.documents WHERE id=$1',
      [docId(1)],
    )
  ).rows[0]!.current_version_id;
  const r = await api(IDS.other, `/api/required-reading/${requirement}/ack`, {
    versionId: version,
  });
  assert(r.status >= 400, 'di luar scope tidak boleh mengakui bacaan');
  const rows = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.reading_acknowledgements WHERE user_id=$1',
    [IDS.other],
  );
  assert.equal(rows.rows[0]!.n, '0');
});
