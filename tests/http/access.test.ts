// Requires pnpm dev in another terminal and the real seeded local DB.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS, docId, versionId } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
let accounts: DemoAccount[];
before(async () => {
  accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  await admin.query('DELETE FROM auth."rateLimit"');
});
after(async () => {
  await admin.query('UPDATE app.profiles SET active=true WHERE id=$1', [IDS.viewer]);
  await admin.query('DELETE FROM auth."rateLimit"');
  await admin.end();
});
async function login(id: string) {
  const a = accounts.find((a) => a.id === id)!;
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  assert.equal(r.status, 200, 'Real sign-in must succeed');
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert(cookie.includes('session'));
  assert(r.headers.getSetCookie().some((c) => /httponly/i.test(c)));
  return cookie;
}
test('unauthenticated catalogue API and raw file endpoint return 401', async () => {
  for (const route of ['/api/documents', `/api/files/${versionId(1)}/markdown`])
    assert.equal((await fetch(base + route)).status, 401);
});
test('public sign-up is unavailable', async () => {
  const r = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 404);
});
test('viewer session is real; direct file and API access cannot leak protected data', async () => {
  const cookie = await login(IDS.viewer);
  const r = await fetch(base + '/api/documents?status=all', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const content = await r.text();
  for (const n of [6, 7, 8, 9]) assert(!content.includes(docId(n)));
  assert(!content.includes('SYNTHETIC-CONFIDENTIAL'));
  const file = await fetch(base + `/api/files/${versionId(1)}/markdown`, {
    headers: { Cookie: cookie },
  });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment;/);
  for (const n of [6, 7, 8, 9])
    assert.equal(
      (await fetch(base + `/api/files/${versionId(n)}/markdown`, { headers: { Cookie: cookie } }))
        .status,
      404,
    );
});
test('origin check protects account changes and auth endpoints', async () => {
  const cookie = await login(IDS.super);
  const r = await fetch(base + `/api/users/${IDS.viewer}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{"active":false}',
  });
  assert.equal(r.status, 400);
  const signIn = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(signIn.status, 400);
});
test('viewer cannot promote or manage another user by crafting requests', async () => {
  const cookie = await login(IDS.viewer);
  const r = await fetch(base + `/api/users/${IDS.other}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: '{"active":false,"role":"super_admin"}',
  });
  assert.equal(r.status, 403);
});
test('logout invalidates a previously working session', async () => {
  const cookie = await login(IDS.contributor);
  const r = await fetch(base + '/api/auth/sign-out', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base + '/api/documents', { headers: { Cookie: cookie } })).status, 401);
});
test('oversized auth body rejected before provider/database processing', async () => {
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: 'x'.repeat(5000),
  });
  assert.equal(r.status, 413);
});

test('the dashboard CSV report follows the analytics capability and the actor scope', async () => {
  // Two more sign-ins after the suite above: clear the login limiter first.
  await admin.query('DELETE FROM auth."rateLimit"');
  // A viewer has no analytics.view: the report is refused before any query runs.
  const viewer = await login(IDS.viewer);
  const denied = await fetch(base + '/api/reports/dashboard?days=30', {
    headers: { Cookie: viewer },
  });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(base + '/api/reports/dashboard')).status, 401);
  // The knowledge admin gets a CSV with the sections the page shows and a BOM for Excel.
  const adminCookie = await login(IDS.admin);
  const ok = await fetch(base + '/api/reports/dashboard?days=7', {
    headers: { Cookie: adminCookie },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(ok.headers.get('content-disposition') ?? '', /intradocs-dashboard-.*-7h\.csv/);
  // text() would strip the BOM while decoding; check the bytes, then the text.
  const bytes = new Uint8Array(await ok.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const csv = new TextDecoder().decode(bytes);
  assert(csv.startsWith('Laporan dashboard IntraDocs'));
  for (const section of [
    'Periode (hari),7',
    'Dokumen aktif,',
    'Tanggal,Pembacaan,Pertanyaan AI',
    'Kontributor,Dokumen disetujui',
  ])
    assert(csv.includes(section), section);
  // Gap terms never travel in the file, whatever the log holds.
  assert(!/harga saham/i.test(csv));
});
