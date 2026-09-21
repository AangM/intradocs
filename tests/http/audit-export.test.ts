/**
 * GET /api/reports/audit: only audit.view holders; the file carries the requested range
 * and action under the exporter's own scope; a bad filter is a 400; and the export is
 * itself the newest row of the trail.
 */
import test, { after, before } from 'node:test';
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

async function login(id: string) {
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  await db.query('DELETE FROM auth."rateLimit"');
  const a = accounts.find((a) => a.id === id)!;
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
const get = (actor: string, qs: string) =>
  fetch(`${base}/api/reports/audit?${qs}`, { headers: { Cookie: cookies.get(actor) ?? '' } });
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  for (const id of [IDS.super, IDS.viewer, IDS.contributor]) await login(id);
});
after(async () => {
  await db.query("DELETE FROM app.audit_events WHERE action='audit.exported'");
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
});

test('a viewer and a contributor have no export', async () => {
  assert.equal((await get(IDS.viewer, `from=${today}&to=${today}`)).status, 403);
  assert.equal((await get(IDS.contributor, `from=${today}&to=${today}`)).status, 403);
});

test('a bad range, an unknown action or an unknown format is a 400', async () => {
  assert.equal((await get(IDS.super, 'from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await get(IDS.super, 'from=2024-01-01&to=2026-01-01')).status, 400);
  assert.equal((await get(IDS.super, 'action=document.evil')).status, 400);
  assert.equal((await get(IDS.super, 'format=xlsx')).status, 400);
});

test('the CSV carries the range and only the asked action, and the export is recorded', async () => {
  // Make sure there is at least one read in range.
  await db.query(
    `INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES($1,'document.read',$2,public.gen_random_uuid())`,
    [IDS.viewer, '20000000-0000-4000-8000-000000000001'],
  );
  const r = await get(IDS.super, `from=${today}&to=${today}&action=document.read&format=csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(r.headers.get('content-disposition') ?? '', /intradocs-audit-.*document\.read\.csv/);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const text = await r.text();
  const lines = text.trimEnd().split('\r\n');
  assert(lines[0]!.startsWith('# IntraDocs audit log,'));
  assert.equal(
    lines[1],
    'id,waktu_utc,aktivitas,keterangan,pelaku_id,pelaku,dokumen_id,dokumen,subjek_id,subjek',
  );
  const body = lines.slice(2, -1);
  assert(body.length >= 1);
  for (const line of body) assert.match(line, /^[^,]+,[^,]+,document\.read,Dokumen dibuka,/);
  assert.match(lines.at(-1)!, /^# \d+ baris$/);
  const recorded = await db.query(
    "SELECT count(*)::int AS n FROM app.audit_events WHERE action='audit.exported' AND actor_id=$1",
    [IDS.super],
  );
  assert(recorded.rows[0].n >= 1, 'the export is in the trail');
});

test('JSON Lines has a header, events, and a trailer whose count matches', async () => {
  const r = await get(IDS.super, `from=${today}&to=${today}&format=jsonl`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /x-ndjson/);
  const objs = (await r.text())
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(objs[0].type, 'header');
  assert.equal(objs.at(-1).type, 'trailer');
  assert.equal(objs.at(-1).rows, objs.length - 2);
  assert(objs.slice(1, -1).every((o) => o.type === 'event' && typeof o.at === 'string'));
});
