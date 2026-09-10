// V1/S07 · saran label. Real HTTP + PostgreSQL/RLS.
// A suggestion is advice, so the route has to be as tight as anything that decides.
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
const route = '/api/rag/label-suggestions';

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
async function api(actor: string, body: unknown, origin = base) {
  return fetch(base + route, {
    method: 'POST',
    headers: {
      Cookie: cookies.get(actor) ?? '',
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  for (const id of [IDS.viewer, IDS.contributor]) await login(id);
});
after(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('anonymous callers are refused', async () => {
  const r = await fetch(base + route, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: docId(1) }),
  });
  assert(r.status >= 400, 'tanpa sesi harus ditolak');
});

test('a viewer cannot ask for suggestions', async () => {
  // A viewer can never create a revision, so a suggestion would be pure disclosure.
  const r = await api(IDS.viewer, { documentId: docId(1) });
  assert(r.status >= 400, 'viewer tidak punya documents.upload');
});

test('a cross-origin request is refused even with a valid session', async () => {
  const r = await api(IDS.contributor, { documentId: docId(1) }, 'https://evil.example');
  assert(r.status >= 400);
});

test('an extra field in the body is refused', async () => {
  const r = await api(IDS.contributor, { documentId: docId(1), knowledgeBaseId: 'lain' });
  assert.equal(r.status, 400);
});

test('a malformed document id is refused before anything is queried', async () => {
  const r = await api(IDS.contributor, { documentId: 'bukan-uuid' });
  assert.equal(r.status, 400);
});

test('a document outside the actor scope answers "nothing to suggest", not "forbidden"', async () => {
  // docId(7) is the confidential attachment in Keamanan Informasi. The contributor holds
  // documents.upload but has no scope there, so the capability check passes and the
  // question becomes what the data layer says. Answering 403 at that point would confirm
  // the document exists; the route answers exactly as for one that was never indexed.
  const r = await api(IDS.contributor, { documentId: docId(7) });
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  const body = JSON.parse(payload) as {
    available: boolean;
    suggested: string[];
    current: string[];
  };
  assert.equal(body.available, false);
  assert.deepEqual(body.suggested, []);
  assert.deepEqual(body.current, [], 'label dokumen orang lain tidak boleh ikut bocor');
});

test('an owner gets a shaped answer and the response carries no document text', async () => {
  const indexed = await db.query<{ document_id: string }>(
    `SELECT e.document_id FROM app.rag_index_entries e
     JOIN app.documents d ON d.id=e.document_id
     WHERE d.owner_id=$1 AND NOT d.withdrawn LIMIT 1`,
    [IDS.contributor],
  );
  if (indexed.rows.length === 0) return;
  const r = await api(IDS.contributor, { documentId: indexed.rows[0]!.document_id });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const body = JSON.parse(text) as {
    available: boolean;
    suggested: string[];
    discarded: number;
    current: string[];
  };
  assert.equal(Object.keys(body).sort().join(','), 'available,current,discarded,suggested');
  assert(Array.isArray(body.suggested) && Array.isArray(body.current));
  // Every suggestion has to be a real label of that document's category.
  const vocabulary = await db.query<{ name: string }>(
    `SELECT l.name FROM app.labels l
     JOIN app.document_versions v ON v.category_id=l.category_id
     JOIN app.documents d ON d.current_version_id=v.id
     WHERE d.id=$1 AND l.merged_into IS NULL`,
    [indexed.rows[0]!.document_id],
  );
  const allowed = new Set(vocabulary.rows.map((x) => x.name));
  for (const s of body.suggested) assert(allowed.has(s), `label asing bocor: ${s}`);
  assert(text.length < 2000, 'respons saran tidak boleh membawa potongan dokumen');
});
