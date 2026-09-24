/**
 * The Technology Architecture flow against the running server: an admin proposes a
 * Sparx export (scanned, stored), a second admin approves, readers see and ask, others
 * see nothing. Uses its own category so the demo model in Infrastruktur is untouched.
 * REVIEW_URL targets a server whose public origin differs from .env.local (a tunnel).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const base = process.env.REVIEW_URL ?? process.env.APP_URL!;
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const cookies = new Map<string, string>();
const category = randomUUID();
let xmi: Uint8Array;

async function login(id: string) {
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  await db.query('DELETE FROM auth."rateLimit"');
  const a = accounts.find((x) => x.id === id)!;
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
const post = (id: string, route: string, body: unknown) =>
  fetch(base + route, {
    method: 'POST',
    headers: { Cookie: cookies.get(id) ?? '', Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
function upload(
  id: string,
  mode: 'preview' | 'submit',
  sha?: string,
  name = 'model.xmi',
  bytes = xmi,
) {
  const f = new FormData();
  f.set('file', new Blob([bytes as BlobPart]), name);
  f.set('categoryId', category);
  f.set('mode', mode);
  if (sha) f.set('sha256', sha);
  return fetch(base + '/api/ta/import', {
    method: 'POST',
    headers: { Cookie: cookies.get(id) ?? '', Origin: base },
    body: f,
  });
}

before(async () => {
  xmi = new Uint8Array(await readFile(path.join(ROOT, 'fixtures/ta/sparx-technology-demo.xmi')));
  await db.query(
    "INSERT INTO app.categories(id,name,description) VALUES($1,'Uji TA HTTP '||$2,'sementara')",
    [category, category.slice(0, 8)],
  );
  await db.query('INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2)', [
    IDS.viewer,
    category,
  ]);
  for (const id of [IDS.admin, IDS.super, IDS.viewer, IDS.other, IDS.contributor]) await login(id);
});
after(async () => {
  const blobs = await db.query('SELECT blob_key FROM app.ta_imports WHERE category_id=$1', [
    category,
  ]);
  await db.query('DELETE FROM app.ta_elements WHERE category_id=$1', [category]);
  await db.query('DELETE FROM app.ta_imports WHERE category_id=$1', [category]);
  await db.query('DELETE FROM app.category_grants WHERE category_id=$1', [category]);
  await db.query('DELETE FROM app.categories WHERE id=$1', [category]);
  for (const b of blobs.rows)
    await rm(
      path.resolve(ROOT, process.env.STORAGE_ROOT ?? 'var/storage', path.dirname(b.blob_key)),
      { recursive: true, force: true },
    );
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('only admins reach the import; bad and infected files are refused before anything is written', async () => {
  assert.equal((await upload(IDS.viewer, 'preview')).status, 403);
  assert.equal((await upload(IDS.contributor, 'preview')).status, 403);
  assert.equal(
    (await upload(IDS.admin, 'preview', undefined, 'x.docx', new TextEncoder().encode('x'))).status,
    400,
  );
  const xxe = new TextEncoder().encode(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
  );
  assert.equal((await upload(IDS.admin, 'preview', undefined, 'evil.xmi', xxe)).status, 400);
  // The EICAR test string: ClamAV must stop it before the parser sees it.
  const eicar = new TextEncoder().encode(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  const infected = await upload(IDS.admin, 'preview', undefined, 'model.csv', eicar);
  assert(infected.status >= 400 && infected.status < 500, `infected file: ${infected.status}`);
});

test('preview and submit change nothing; the proposer cannot approve; another admin applies it', async () => {
  const p = await upload(IDS.admin, 'preview');
  assert.equal(p.status, 200);
  const preview = (await p.json()) as { sha256: string; created: number; diff: unknown[] };
  assert.equal(preview.created, 31);
  assert.equal(preview.diff.length, 31);
  assert.equal(
    (await upload(IDS.admin, 'submit', 'b'.repeat(64))).status,
    400,
    'other bytes than previewed',
  );
  const s = await upload(IDS.admin, 'submit', preview.sha256);
  assert.equal(s.status, 201);
  const { id } = (await s.json()) as { id: string };
  assert.notEqual(
    (await upload(IDS.admin, 'submit', preview.sha256)).status,
    201,
    'same file already pending',
  );
  const pending = await db.query(
    'SELECT count(*)::int AS n FROM app.ta_elements WHERE category_id=$1',
    [category],
  );
  assert.equal(pending.rows[0].n, 0, 'nothing applied while pending');
  // The original is kept and downloadable by admins, byte for byte.
  const original = await fetch(`${base}/api/ta/import/${id}/original`, {
    headers: { Cookie: cookies.get(IDS.super)! },
  });
  assert.equal(original.status, 200);
  assert.equal(Buffer.from(await original.arrayBuffer()).length, xmi.length);
  const denied = await fetch(`${base}/api/ta/import/${id}/original`, {
    headers: { Cookie: cookies.get(IDS.viewer)! },
  });
  assert.equal(denied.status, 403);
  assert.notEqual(
    (await post(IDS.admin, `/api/ta/import/${id}`, { decision: 'approve' })).status,
    200,
    'four eyes: the proposer cannot approve',
  );
  assert.equal(
    (await post(IDS.viewer, `/api/ta/import/${id}`, { decision: 'approve' })).status,
    403,
  );
  const ok = await post(IDS.super, `/api/ta/import/${id}`, {
    decision: 'approve',
    note: 'Model uji.',
  });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { created: number }).created, 31);
});

test('readers ask and see; someone outside the category sees nothing, by page, question or search', async () => {
  const r = await post(IDS.viewer, '/api/ta/ask', {
    question: 'Apa dampaknya jika srv-db-01 mati?',
  });
  const impact = (await r.json()) as { type: string; items: Array<{ name: string }> };
  assert.equal(impact.type, 'impact');
  assert(impact.items.some((i) => i.name === 'Portal Tiket'));
  const { rows } = await db.query(
    "SELECT id FROM app.ta_elements WHERE category_id=$1 AND name='srv-db-01'",
    [category],
  );
  const page = await (
    await fetch(`${base}/arsitektur/${rows[0].id}`, {
      headers: { Cookie: cookies.get(IDS.viewer)! },
    })
  ).text();
  assert.match(page, /Dampak jika tidak tersedia/);
  assert.match(page, /Riwayat perubahan/);
  assert.match(page, /Budi Hartono/, 'the approver is named in the history');
  const hidden = await (
    await fetch(`${base}/arsitektur/${rows[0].id}`, {
      headers: { Cookie: cookies.get(IDS.other)! },
    })
  ).text();
  assert.doesNotMatch(hidden, /10\.10\.30\.41|Dampak jika tidak tersedia/);
  const search = await (
    await fetch(`${base}/search?q=srv-db`, { headers: { Cookie: cookies.get(IDS.viewer)! } })
  ).text();
  assert.match(search, /Technology Architecture/);
  const outsider = await (
    await fetch(`${base}/search?q=srv-db`, { headers: { Cookie: cookies.get(IDS.other)! } })
  ).text();
  assert.doesNotMatch(outsider, /\/arsitektur\//);
});

test('bad questions, anonymous and cross-origin calls are refused', async () => {
  assert.equal((await post(IDS.viewer, '/api/ta/ask', { question: 'x' })).status, 400);
  assert.equal((await post(IDS.viewer, '/api/ta/ask', { question: 'a'.repeat(501) })).status, 400);
  const cross = await fetch(base + '/api/ta/ask', {
    method: 'POST',
    headers: {
      Cookie: cookies.get(IDS.viewer)!,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question: 'srv-db-01' }),
  });
  assert.equal(cross.status, 400);
  const anon = await fetch(base + '/api/ta/ask', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: '{"question":"srv-db-01"}',
  });
  assert.equal(anon.status, 401);
});
