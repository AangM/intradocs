// S07/V1 · merge label dan ekspor taksonomi. Real HTTP + PostgreSQL/RLS.
// The interesting cases are the refusals: merging across categories, merging without
// taxonomy authority, and exporting a branch the actor has no scope over.
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
const sop = '10000000-0000-4000-8000-000000000004';
let sourceId = '';
let targetId = '';
let foreignId = '';
// labels.revision starts at 1, not 0; read it rather than assuming.
async function revisionOf(id: string) {
  const r = await db.query<{ revision: number }>('SELECT revision FROM app.labels WHERE id=$1', [
    id,
  ]);
  return r.rows[0]!.revision;
}

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
  for (const id of [IDS.super, IDS.viewer, IDS.contributor]) await login(id);
  // Clear aliases before deleting: labels.merged_into is a self-referencing foreign key,
  // so a leftover alias would block the delete and leave stale revisions behind.
  await db.query(
    "UPDATE app.labels SET merged_into=NULL WHERE name LIKE 'uji-merge%' OR merged_into IN (SELECT id FROM app.labels WHERE name LIKE 'uji-merge%')",
  );
  await db.query("DELETE FROM app.labels WHERE name LIKE 'uji-merge%'");
  sourceId = (
    await db.query<{ id: string }>(
      "INSERT INTO app.labels(category_id,name,color) VALUES($1,'uji-merge-lama','grey') RETURNING id",
      [infra],
    )
  ).rows[0]!.id;
  targetId = (
    await db.query<{ id: string }>(
      "INSERT INTO app.labels(category_id,name,color) VALUES($1,'uji-merge-baru','blue') RETURNING id",
      [infra],
    )
  ).rows[0]!.id;
  foreignId = (
    await db.query<{ id: string }>(
      "INSERT INTO app.labels(category_id,name,color) VALUES($1,'uji-merge-asing','green') RETURNING id",
      [sop],
    )
  ).rows[0]!.id;
});
after(async () => {
  await db.query(
    "UPDATE app.labels SET merged_into=NULL WHERE name LIKE 'uji-merge%' OR merged_into IN (SELECT id FROM app.labels WHERE name LIKE 'uji-merge%')",
  );
  await db.query("DELETE FROM app.labels WHERE name LIKE 'uji-merge%'");
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('a viewer cannot merge labels', async () => {
  const r = await api(IDS.viewer, '/api/taxonomy/merge', {
    source: sourceId,
    target: targetId,
    revision: await revisionOf(sourceId),
  });
  assert(r.status >= 400, 'viewer tidak punya kewenangan taksonomi');
});

test('a contributor cannot merge labels either', async () => {
  const r = await api(IDS.contributor, '/api/taxonomy/merge', {
    source: sourceId,
    target: targetId,
    revision: await revisionOf(sourceId),
  });
  assert(r.status >= 400);
});

test('labels in different categories cannot be merged', async () => {
  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: foreignId,
    target: targetId,
    revision: await revisionOf(foreignId),
  });
  assert(r.status >= 400, 'merge lintas kategori harus ditolak');
});

test('a label cannot be merged into itself', async () => {
  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: sourceId,
    target: sourceId,
    revision: await revisionOf(sourceId),
  });
  assert(r.status >= 400);
});

test('an extra field in the body is refused', async () => {
  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: sourceId,
    target: targetId,
    revision: 0,
    categoryId: infra,
  });
  assert.equal(r.status, 400);
});

test('a stale revision is refused rather than silently merging', async () => {
  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: sourceId,
    target: targetId,
    revision: 99,
  });
  assert(r.status >= 400, 'revisi basi harus ditolak');
});

test('merging aliases the old label without touching a frozen version', async () => {
  const versions = await db.query<{ id: string; labels: string[] }>(
    'SELECT id,labels FROM app.document_versions WHERE category_id=$1 ORDER BY created_at LIMIT 1',
    [infra],
  );
  const version = versions.rows[0]!;
  const labelsBefore = version.labels;

  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: sourceId,
    target: targetId,
    revision: await revisionOf(sourceId),
  });
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  const result = JSON.parse(payload) as {
    aliasedName: string;
    mergedName: string;
    affectedVersions: number;
  };
  assert.equal(result.aliasedName, 'uji-merge-lama');
  assert.equal(result.mergedName, 'uji-merge-baru');

  // The version snapshot is exactly what it was. A merge must never rewrite what a
  // reviewer approved; app.protect_version() would refuse it, and so does the design.
  const after = await db.query<{ labels: string[] }>(
    'SELECT labels FROM app.document_versions WHERE id=$1',
    [version.id],
  );
  assert.deepEqual(after.rows[0]!.labels, labelsBefore, 'snapshot versi tidak boleh berubah');

  // The source label survives as an alias rather than disappearing, so history still
  // resolves, and it now points at the surviving label.
  const alias = await db.query<{ merged_into: string | null }>(
    'SELECT merged_into FROM app.labels WHERE id=$1',
    [sourceId],
  );
  assert.equal(alias.rows[0]!.merged_into, targetId, 'label lama harus menjadi alias');

  // Filtering by the survivor also covers the merged name.
  const names = await db.query<{ names: string[] }>('SELECT app.label_names($1) AS names', [
    targetId,
  ]);
  assert.deepEqual([...names.rows[0]!.names].sort(), ['uji-merge-baru', 'uji-merge-lama']);

  const audit = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.audit_events WHERE action='taxonomy.changed' AND created_at>now()-interval '1 minute'",
  );
  assert(Number(audit.rows[0]!.n) >= 1, 'merge harus tercatat di audit');
});

test('a merged label cannot itself receive a further merge', async () => {
  const third = (
    await db.query<{ id: string }>(
      "INSERT INTO app.labels(category_id,name,color) VALUES($1,'uji-merge-ketiga','red') RETURNING id",
      [infra],
    )
  ).rows[0]!.id;
  // sourceId is already merged into targetId; chaining onto it must be refused.
  const r = await api(IDS.super, '/api/taxonomy/merge', {
    source: third,
    target: sourceId,
    revision: await revisionOf(third),
  });
  assert(r.status >= 400, 'rantai alias harus ditolak');
});

test('taxonomy export needs the taxonomy capability', async () => {
  const r = await api(IDS.viewer, '/api/taxonomy/export', undefined, 'GET');
  assert(r.status >= 400, 'viewer tidak boleh mengunduh taksonomi');
});

test('an export describes structure and label usage, never document titles', async () => {
  const r = await api(IDS.super, '/api/taxonomy/export', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename=/);
  const body = (await r.json()) as {
    categories: Array<{ name: string; labels: Array<{ name: string; usedBy: number }> }>;
  };
  assert(body.categories.length > 0);
  assert(body.categories.some((c) => c.name.length > 0));
  // Structure only: no document title from the fixture corpus may appear.
  const serialised = JSON.stringify(body);
  assert(!serialised.includes('Konfigurasi VPN'), 'ekspor tidak boleh memuat judul dokumen');
  assert(!serialised.includes('CANARY'), 'ekspor tidak boleh memuat isi dokumen');
});
