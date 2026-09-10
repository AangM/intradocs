// S04/V1 · perbandingan versi dan pemulihan. Real HTTP + PostgreSQL/RLS + ClamAV +
// converter + worker, on the local synthetic dataset only. The document used here is
// built through the ordinary upload/approve path, so what is compared and restored is a
// genuinely published version rather than a row inserted for the test.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS, docId } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const infra = '10000000-0000-4000-8000-000000000001';
const cookies = new Map<string, string>();
const marker = 'VERSI-' + randomUUID().slice(0, 8);
let first: { documentId: string; versionId: string; slug: string };
let second: { versionId: string };

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
async function upload(text: string, existing?: { documentId: string; versionId: string }) {
  const form = new FormData();
  form.set(
    'file',
    new File([new TextEncoder().encode(text)], 'versi.md', { type: 'text/markdown' }),
  );
  for (const [k, v] of Object.entries({
    title: `Uji versi ${marker}`,
    summary: 'Dokumen sintetis pengujian perbandingan versi',
    categoryId: infra,
    classification: 'internal',
    labels: '[]',
    synthetic: 'true',
  }))
    form.set(k, v);
  if (existing) {
    form.set('documentId', existing.documentId);
    form.set('baseVersionId', existing.versionId);
  }
  const r = await fetch(base + '/api/documents/drafts', {
    method: 'POST',
    headers: {
      Cookie: cookies.get(IDS.contributor)!,
      Origin: base,
      'Idempotency-Key': randomUUID(),
    },
    body: form,
  });
  const value = await r.json();
  assert.equal(r.status, 201, JSON.stringify(value));
  return value as { documentId: string; versionId: string; slug: string };
}
async function publish(versionId: string) {
  const submit = await api(IDS.contributor, `/api/versions/${versionId}/submit`, {
    reviewers: [IDS.admin],
    confirmed: true,
  });
  assert.equal(submit.status, 200, `submit: ${await submit.text()}`);
  const decided = await api(IDS.admin, `/api/versions/${versionId}/decision`, {
    decision: 'approve',
    reason: '',
  });
  assert.equal(decided.status, 200, `decision: ${await decided.text()}`);
  for (let i = 0; i < 60; i += 1) {
    const r = await db.query('SELECT publication_state FROM app.document_versions WHERE id=$1', [
      versionId,
    ]);
    if (r.rows[0]?.publication_state === 'published') return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('versi tidak terbit dalam batas waktu');
}

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  for (const id of [IDS.contributor, IDS.admin, IDS.viewer, IDS.other]) await login(id);
  first = await upload(`# Panduan versi\n\n## Bagian A\n\nBaris asli satu.\nBaris asli dua.\n`);
  await publish(first.versionId);
  const revision = await upload(
    `# Panduan versi\n\n## Bagian A\n\nBaris asli satu.\nBaris sudah diubah.\nBaris tambahan.\n`,
    { documentId: first.documentId, versionId: first.versionId },
  );
  second = { versionId: revision.versionId };
  await publish(revision.versionId);
});
after(async () => {
  // Leave the catalogue as it was found: the document was created by this suite.
  await db.query('UPDATE app.documents SET withdrawn=true WHERE id=$1', [first.documentId]);
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('the compare page shows what changed between two versions', async () => {
  const r = await api(
    IDS.contributor,
    `/dokumen/${first.documentId}/${first.slug}/versi?left=${first.versionId}&right=${second.versionId}`,
    undefined,
    'GET',
  );
  assert.equal(r.status, 200);
  const html = await r.text();
  assert(html.includes('Baris sudah diubah'), 'baris baru harus tampil');
  assert(html.includes('Baris asli dua'), 'baris lama harus tampil sebagai penghapusan');
  assert(html.includes('Bandingkan versi'));
});

test('a reader outside the category cannot compare versions of that document', async () => {
  const r = await api(
    IDS.other,
    `/dokumen/${first.documentId}/${first.slug}/versi?left=${first.versionId}&right=${second.versionId}`,
    undefined,
    'GET',
  );
  // The app answers unauthorised document routes with its not-found page rather than a
  // 404 status; that convention predates this page and is the same on the reader itself.
  // What matters here is that no version text crosses the boundary.
  const html = await r.text();
  assert(!html.includes('Baris asli'), 'teks versi lama tidak boleh keluar');
  assert(!html.includes('Baris sudah diubah'), 'teks versi baru tidak boleh keluar');
  assert(!html.includes('Bandingkan versi'), 'halaman diff tidak boleh dirender');
});

test('versions of a different document can never be compared side by side', async () => {
  // docId(5) belongs to another category entirely; pairing it with this document must
  // fail rather than render one readable version next to an unrelated one.
  const foreign = await db.query('SELECT current_version_id FROM app.documents WHERE id=$1', [
    docId(5),
  ]);
  const r = await api(
    IDS.contributor,
    `/dokumen/${first.documentId}/${first.slug}/versi?left=${foreign.rows[0].current_version_id}&right=${second.versionId}`,
    undefined,
    'GET',
  );
  const html = await r.text();
  assert(!html.includes('Bandingkan versi'), 'pasangan lintas dokumen tidak boleh dirender');
  assert(!html.includes('Matriks SLA'), 'isi dokumen lain tidak boleh muncul');
});

test('rollback is refused for anyone who does not own the document', async () => {
  for (const actor of [IDS.admin, IDS.viewer, IDS.other]) {
    const r = await api(actor, `/api/documents/${first.documentId}/rollback`, {
      versionId: first.versionId,
    });
    assert(r.status >= 400, `${actor} tidak boleh memulihkan versi`);
  }
});

test('rollback rejects a body carrying anything beyond the version id', async () => {
  const r = await api(IDS.contributor, `/api/documents/${first.documentId}/rollback`, {
    versionId: first.versionId,
    reviewState: 'approved',
  });
  assert.equal(r.status, 400);
});

test('rollback opens a draft with the old text and never republishes by itself', async () => {
  const r = await api(IDS.contributor, `/api/documents/${first.documentId}/rollback`, {
    versionId: first.versionId,
  });
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  const created = JSON.parse(payload) as { versionId: string; label: string };

  const row = await db.query(
    'SELECT review_state,publication_state,markdown_sha256,version_number FROM app.document_versions WHERE id=$1',
    [created.versionId],
  );
  assert.equal(row.rows[0].review_state, 'draft', 'pemulihan masuk jalur review, bukan terbit');
  assert.equal(row.rows[0].publication_state, 'unpublished');

  // The restored draft must carry exactly the bytes of the version it restored.
  const source = await db.query('SELECT markdown_sha256 FROM app.document_versions WHERE id=$1', [
    first.versionId,
  ]);
  assert.equal(row.rows[0].markdown_sha256, source.rows[0].markdown_sha256);

  // The published version is still the newer one: nothing was rewritten.
  const active = await db.query('SELECT current_version_id FROM app.documents WHERE id=$1', [
    first.documentId,
  ]);
  assert.equal(active.rows[0].current_version_id, second.versionId);

  const audit = await db.query(
    "SELECT count(*)::int AS n FROM app.audit_events WHERE document_id=$1 AND action='document.rolled_back'",
    [first.documentId],
  );
  assert.equal(audit.rows[0].n, 1, 'pemulihan harus tercatat di audit');
});

test('a second rollback is refused while the restored draft is still open', async () => {
  const r = await api(IDS.contributor, `/api/documents/${first.documentId}/rollback`, {
    versionId: first.versionId,
  });
  assert(r.status >= 400, 'hanya satu draft terbuka pada satu waktu');
});
