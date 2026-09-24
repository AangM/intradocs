/**
 * The Technology Architecture endpoints against the running server, on the synthetic
 * model in Infrastruktur & Jaringan (imported by `pnpm demo:content` or by the import
 * test below when absent). REVIEW_URL targets a server whose public origin differs from
 * .env.local, such as the review tunnel.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';

const base = process.env.REVIEW_URL ?? process.env.APP_URL!;
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const cookies = new Map<string, string>();
const INFRA = '10000000-0000-4000-8000-000000000001';

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
const ask = (id: string, question: string) =>
  fetch(base + '/api/ta/ask', {
    method: 'POST',
    headers: { Cookie: cookies.get(id) ?? '', Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
async function importAs(
  id: string,
  mode: 'preview' | 'apply',
  sha?: string,
  name = 'sparx-technology-demo.xmi',
  body?: Uint8Array,
) {
  const bytes =
    body ??
    new Uint8Array(await readFile(path.join(ROOT, 'fixtures/ta/sparx-technology-demo.xmi')));
  const f = new FormData();
  f.set('file', new Blob([bytes as BlobPart]), name);
  f.set('categoryId', INFRA);
  f.set('mode', mode);
  if (sha) f.set('sha256', sha);
  return fetch(base + '/api/ta/import', {
    method: 'POST',
    headers: { Cookie: cookies.get(id) ?? '', Origin: base },
    body: f,
  });
}

before(async () => {
  for (const id of [IDS.admin, IDS.viewer, IDS.other, IDS.contributor]) await login(id);
});
after(async () => {
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('only admins reach the import; a viewer or contributor gets 403, a bad file 400', async () => {
  assert.equal((await importAs(IDS.viewer, 'preview')).status, 403);
  assert.equal((await importAs(IDS.contributor, 'preview')).status, 403);
  assert.equal(
    (await importAs(IDS.admin, 'preview', undefined, 'x.docx', new TextEncoder().encode('x')))
      .status,
    400,
  );
  const xxe = new TextEncoder().encode(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
  );
  assert.equal((await importAs(IDS.admin, 'preview', undefined, 'evil.xmi', xxe)).status, 400);
});

test('preview then apply the same file; apply with another hash is refused', async () => {
  const p = await importAs(IDS.admin, 'preview');
  assert.equal(p.status, 200);
  const preview = (await p.json()) as { sha256: string; elements: number; relations: number };
  assert.equal(preview.elements, 31);
  assert.equal(preview.relations, 51);
  assert.equal((await importAs(IDS.admin, 'apply', 'b'.repeat(64))).status, 400);
  const a = await importAs(IDS.admin, 'apply', preview.sha256);
  assert.equal(a.status, 200);
  const { summary } = (await a.json()) as {
    summary: { created: number; unchanged: number; updated: number };
  };
  assert.equal(summary.created + summary.unchanged + summary.updated, 31);
});

test('questions are answered from the data the asker may see', async () => {
  const r = await ask(IDS.viewer, 'Apa dampaknya jika srv-db-01 mati?');
  assert.equal(r.status, 200);
  const impact = (await r.json()) as { type: string; items: Array<{ name: string }> };
  assert.equal(impact.type, 'impact');
  assert(impact.items.some((i) => i.name === 'Portal Tiket'));
  const eos = (await (await ask(IDS.viewer, 'Server mana yang sudah end of support?')).json()) as {
    items: Array<{ name: string }>;
  };
  assert(eos.items.some((i) => i.name === 'srv-mon-01'));
  // fajar reads SOP only: the same questions find nothing, and nothing leaks by name.
  const f = (await (await ask(IDS.other, 'Apa dampaknya jika srv-db-01 mati?')).json()) as {
    type: string;
    items: unknown[];
    text: string;
  };
  assert.notEqual(f.type, 'impact');
  assert.equal(f.items.length, 0);
  assert.doesNotMatch(f.text, /srv-db-01/);
});

test('bad questions and cross-origin requests are refused', async () => {
  assert.equal((await ask(IDS.viewer, 'x')).status, 400);
  assert.equal((await ask(IDS.viewer, 'a'.repeat(501))).status, 400);
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
  assert.equal(
    (
      await fetch(base + '/api/ta/ask', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: '{"question":"srv-db-01"}',
      })
    ).status,
    401,
  );
});

test('pages: the catalogue and an element page render for a reader; out of scope, nothing leaks', async () => {
  const list = await fetch(base + '/arsitektur', { headers: { Cookie: cookies.get(IDS.viewer)! } });
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.match(html, /Technology Architecture/);
  assert.match(html, /srv-db-01/);
  const { rows } = await db.query(
    "SELECT id FROM app.ta_elements WHERE category_id=$1 AND name='srv-db-01'",
    [INFRA],
  );
  const el = await fetch(base + `/arsitektur/${rows[0].id}`, {
    headers: { Cookie: cookies.get(IDS.viewer)! },
  });
  assert.equal(el.status, 200);
  assert.match(await el.text(), /Dampak jika tidak tersedia/);
  // Out of scope answers with the not-found page, the same convention as the document
  // reader (see versions.test.ts): what matters is that nothing of the element crosses.
  const hidden = await (
    await fetch(base + `/arsitektur/${rows[0].id}`, {
      headers: { Cookie: cookies.get(IDS.other)! },
    })
  ).text();
  assert.doesNotMatch(hidden, /10\.10\.30\.41|Dampak jika tidak tersedia|esx-jkt-02/);
  const catalogue = await (
    await fetch(base + '/arsitektur', { headers: { Cookie: cookies.get(IDS.other)! } })
  ).text();
  assert.doesNotMatch(catalogue, /srv-db-01/);
  assert.match(catalogue, /Belum ada model arsitektur di cakupan Anda/);
});
