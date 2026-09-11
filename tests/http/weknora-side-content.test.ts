// M4 · konten yang lahir di sisi WeKnora. Real HTTP + WeKnora + PostgreSQL/RLS.
//
// WeKnora can create records IntraDocs never asked for: the wiki pipeline synthesises
// pages across documents, FAQ builds entries, its own UI can upload a file. The question
// this suite answers is not "should those be enabled" but "what happens if one exists" --
// because that is what decides whether enabling any of them could ever leak.
//
// The rule under test: a citation is resolved back to IntraDocs by knowledge_id. A record
// with no matching row in app.rag_index_entries resolves to nothing, so it cannot be
// cited, whatever it contains and however well it matches the question.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import { readAiConfig } from '../../packages/core/src/ai-config.ts';
import { WeknoraClient } from '../../packages/core/src/weknora.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const cookies = new Map<string, string>();

// A word that exists nowhere in the fixture corpus, so any hit on it can only be ours.
const token = 'ZARQUONIUM';
const bait =
  `Prosedur ${token} untuk pemulihan tautan satelit\n\n` +
  `Ambang ${token} ditetapkan pada 42 desibel dan wajib diverifikasi setiap kuartal. ` +
  `Dokumen ini tidak pernah melewati IntraDocs.`;

let client: WeknoraClient | null = null;
let planted = '';

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

async function ask(actor: string, route: string, question: string) {
  return fetch(base + route, {
    method: 'POST',
    headers: {
      Cookie: cookies.get(actor) ?? '',
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question }),
  });
}

before(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await login(IDS.contributor);
  const weknora = readAiConfig(process.env).weknora;
  if (!weknora) return;
  client = new WeknoraClient(weknora);
  // Stands in for anything WeKnora produces on its own: a wiki page, a FAQ entry, a file
  // someone dropped through the WeKnora UI. All of them arrive the same way -- a record in
  // the knowledge base with no IntraDocs version behind it.
  planted = await client.createManualKnowledge({
    title: `Halaman sintesis WeKnora ${token}`,
    content: bait,
  });
  await client.reparseKnowledge([planted]);
  // Indexing is asynchronous; give it a bounded window rather than a fixed sleep.
  for (let i = 0; i < 40 && client; i += 1) {
    const hits = await client.hybridSearch({
      knowledgeIds: [planted],
      queryText: `ambang ${token}`,
      matchCount: 5,
    });
    if (hits.length > 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
});

after(async () => {
  if (client && planted) await client.deleteKnowledge(planted);
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('the planted record really is searchable inside WeKnora', async (t) => {
  if (!client) return t.skip('AI mati; tidak ada yang bisa diuji');
  const hits = await client.hybridSearch({
    knowledgeIds: [planted],
    queryText: `ambang ${token} desibel`,
    matchCount: 5,
  });
  // Without this the rest of the suite would pass for the wrong reason: a record that was
  // never indexed is trivially uncitable.
  assert(hits.length > 0, 'record harus benar-benar terindeks agar pengujian bermakna');
  assert(
    hits.some((h) => h.content.includes(token)),
    'isi umpan harus benar-benar ada',
  );
});

test('IntraDocs has no row for it, so it is outside every actor scope', async (t) => {
  if (!client) return t.skip('AI mati');
  const rows = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.rag_index_entries WHERE knowledge_id=$1',
    [planted],
  );
  assert.equal(rows.rows[0]!.n, '0', 'tidak ada versi IntraDocs di belakangnya');
});

test('retrieval never cites a record IntraDocs did not export', async (t) => {
  if (!client) return t.skip('AI mati');
  const r = await ask(IDS.contributor, '/api/rag/search', `Berapa ambang ${token}?`);
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  const body = JSON.parse(payload) as {
    citations: Array<{ snippet: string; documentTitle: string }>;
  };
  for (const citation of body.citations) {
    assert(!citation.snippet.includes(token), 'potongan asing tidak boleh muncul');
    assert(!citation.documentTitle.includes(token), 'judul asing tidak boleh muncul');
  }
});

test('the answer path leaks it no more than the retrieval path does', async (t) => {
  if (!client) return t.skip('AI mati');
  const r = await ask(IDS.contributor, '/api/rag/chat', `Berapa ambang ${token} desibel?`);
  const payload = await r.text();
  assert.equal(r.status, 200, payload);
  // The whole response, answer and citations together: the token must appear nowhere.
  assert(!payload.includes(token), 'konten sisi WeKnora tidak boleh sampai ke pengguna');
});
