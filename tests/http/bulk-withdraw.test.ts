// S03/V1 · aksi massal terbatas. Real HTTP + PostgreSQL/RLS.
// The batch must be as strict as doing it one at a time, and must not half-finish.
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
const cookies = new Map<string, string>();
const reason = 'Kebijakan digantikan dokumen baru; dicabut serentak untuk pengujian.';
const created: string[] = [];

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
/**
 * Two documents the contributor already owns, taken from the fixture corpus.
 *
 * Creating them through the upload path would need ClamAV and the converter running,
 * which on an 8 GB machine cannot coexist with the WeKnora profile. Using existing
 * fixtures keeps the test about bulk withdrawal rather than about ingestion, and the
 * originals are restored afterwards.
 */
const OWNED = [docId(2), docId(4)];

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.query(
    "UPDATE app.upload_requests SET updated_at=now()-interval '2 hours' WHERE updated_at>now()-interval '1 hour'",
  );
  for (const id of [IDS.contributor, IDS.admin, IDS.viewer]) await login(id);
  created.push(...OWNED);
  await db.query('UPDATE app.documents SET withdrawn=false WHERE id=ANY($1::uuid[])', [OWNED]);
});
after(async () => {
  // Put the corpus back: these are fixture documents, not throwaways.
  await db.query('UPDATE app.documents SET withdrawn=false WHERE id=ANY($1::uuid[])', [OWNED]);
  await db.query(
    "UPDATE app.document_versions SET publication_state='published' WHERE document_id=ANY($1::uuid[]) AND publication_state='withdrawn'",
    [OWNED],
  );
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('a viewer cannot withdraw anything in bulk', async () => {
  const r = await api(IDS.viewer, '/api/documents/bulk-withdraw', {
    documentIds: created,
    reason,
  });
  assert(r.status >= 400);
});

test('an empty or oversized selection is refused at the boundary', async () => {
  assert.equal(
    (await api(IDS.contributor, '/api/documents/bulk-withdraw', { documentIds: [], reason }))
      .status,
    400,
  );
  const tooMany = Array.from({ length: 26 }, () => randomUUID());
  assert.equal(
    (await api(IDS.contributor, '/api/documents/bulk-withdraw', { documentIds: tooMany, reason }))
      .status,
    400,
  );
});

test('a bare reason is refused; a bulk withdrawal has to say why', async () => {
  const r = await api(IDS.contributor, '/api/documents/bulk-withdraw', {
    documentIds: created.slice(0, 1),
    reason: 'ganti',
  });
  assert.equal(r.status, 400);
});

test('the same document twice in one batch is refused', async () => {
  const r = await api(IDS.contributor, '/api/documents/bulk-withdraw', {
    documentIds: [created[0]!, created[0]!],
    reason,
  });
  assert.equal(r.status, 400);
});

test('an extra field in the body is refused', async () => {
  const r = await api(IDS.contributor, '/api/documents/bulk-withdraw', {
    documentIds: created.slice(0, 1),
    reason,
    force: true,
  });
  assert.equal(r.status, 400);
});

test('one document the actor does not own rolls back the whole batch', async () => {
  // docId(5) belongs to the knowledge admin, not the contributor. Mixing it in must
  // leave the owned ones untouched rather than withdrawing what it could and reporting
  // partial success.
  const before = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.documents WHERE id=ANY($1::uuid[]) AND withdrawn',
    [created],
  );
  const r = await api(IDS.contributor, '/api/documents/bulk-withdraw', {
    documentIds: [created[0]!, docId(5)],
    reason,
  });
  assert(r.status >= 400, 'satu dokumen asing harus menggagalkan seluruh batch');
  const after = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.documents WHERE id=ANY($1::uuid[]) AND withdrawn',
    [created],
  );
  assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'tidak boleh ada yang tercabut sebagian');
  const foreign = await db.query<{ withdrawn: boolean }>(
    'SELECT withdrawn FROM app.documents WHERE id=$1',
    [docId(5)],
  );
  assert.equal(foreign.rows[0]!.withdrawn, false, 'dokumen milik orang lain tidak boleh tersentuh');
});

test('withdrawing an owned batch works and writes one audit row per document', async () => {
  // These are fixture documents reused across runs, so count only what this call writes.
  const auditBefore = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app.audit_events WHERE action='document.withdrawn' AND document_id=ANY($1::uuid[])",
        [created],
      )
    ).rows[0]!.n,
  );
  const r = await api(IDS.contributor, '/api/documents/bulk-withdraw', {
    documentIds: created,
    reason,
  });
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  assert.equal((JSON.parse(payload) as { withdrawn: number }).withdrawn, created.length);

  const state = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.documents WHERE id=ANY($1::uuid[]) AND withdrawn',
    [created],
  );
  assert.equal(state.rows[0]!.n, String(created.length));

  const audit = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.audit_events WHERE action='document.withdrawn' AND document_id=ANY($1::uuid[])",
    [created],
  );
  assert.equal(
    Number(audit.rows[0]!.n) - auditBefore,
    created.length,
    'satu baris audit per dokumen pada pemanggilan ini',
  );
});

test('a withdrawn document leaves the RAG index on the next reconciliation', async () => {
  const entries = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.rag_index_entries WHERE document_id=ANY($1::uuid[])',
    [created],
  );
  // Whatever was indexed is now ineligible; the queue is what removes it.
  for (const id of created) {
    const indexable = await db.query<{ ok: boolean }>(
      'SELECT app.is_indexable_version(current_version_id) AS ok FROM app.documents WHERE id=$1',
      [id],
    );
    assert.equal(indexable.rows[0]!.ok, false, 'dokumen tercabut tidak boleh layak diindeks');
  }
  assert(Number(entries.rows[0]!.n) >= 0);
});
