/**
 * Migration 045 through the actor, in a throwaway category: who may propose, that the
 * proposer cannot approve their own change set (four eyes), that only an approval changes
 * the model, what a re-import changes and records, and that nothing else writes.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { localAdminUrl, loadLocalEnv } from '../../scripts/shared.ts';
import { closePools } from '../../packages/db/src/index.ts';
import {
  decideTaImport,
  diffTaImport,
  submitTaImport,
  taElementChanges,
  taModel,
  taPendingCount,
} from '../../packages/db/src/ta.ts';
import { parseSparxXmi, type TaParseResult } from '../../packages/core/src/ta.ts';
import { IDS } from '../../fixtures/data.ts';

loadLocalEnv();
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL!, max: 1 });
const category = randomUUID();
const parsed = parseSparxXmi(readFileSync('fixtures/ta/sparx-technology-demo.xmi', 'utf8'));

/** Propose as `who`: a unique hash per call, as distinct files would have. */
async function propose(who: string, p: TaParseResult = parsed) {
  const sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const { diff } = await diffTaImport(who, category, p);
  return submitTaImport(who, {
    categoryId: category,
    parsed: p,
    diff,
    filename: 'uji.xmi',
    format: 'xmi',
    sha256: sha,
    blobKey: `ta-imports/${randomUUID()}/original.xmi`,
    scan: { verdict: 'clean', sha256: sha },
  });
}
const mine = async (who: string) =>
  (await taModel(who)).elements.filter((e) => e.categoryId === category);

before(async () => {
  await admin.query(
    "INSERT INTO app.categories(id,name,description) VALUES($1,'Uji TA '||$2,'Kategori sementara untuk tes TA')",
    [category, category.slice(0, 8)],
  );
  await admin.query('INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$3),($2,$3)', [
    IDS.viewer,
    IDS.contributor,
    category,
  ]);
});
after(async () => {
  await admin.query('DELETE FROM app.ta_elements WHERE category_id=$1', [category]);
  await admin.query('DELETE FROM app.ta_imports WHERE category_id=$1', [category]);
  await admin.query('DELETE FROM app.category_grants WHERE category_id=$1', [category]);
  await admin.query('DELETE FROM app.categories WHERE id=$1', [category]);
  await admin.end();
  await worker.end();
  await closePools();
});

test('only a knowledge or super admin in scope may propose', async () => {
  for (const who of [IDS.viewer, IDS.contributor, IDS.other, IDS.reviewer])
    await assert.rejects(
      () => propose(who),
      /tidak tersedia|Unavailable/i,
      `${who} must not propose`,
    );
});

test('a proposal changes nothing; the proposer cannot approve it; another admin can', async () => {
  const id = await propose(IDS.admin);
  assert.equal((await mine(IDS.viewer)).length, 0, 'pending: the model is untouched');
  assert.equal(await taPendingCount(IDS.admin), 0, 'not in the proposer’s own queue');
  assert((await taPendingCount(IDS.super)) >= 1, 'in the other admin’s queue');
  await assert.rejects(
    () => decideTaImport(IDS.admin, id, 'approve', null),
    /tidak tersedia|Four eyes|Unavailable/i,
  );
  await assert.rejects(() => decideTaImport(IDS.viewer, id, 'approve', null));
  const result = await decideTaImport(IDS.super, id, 'approve', 'Model awal.');
  assert.equal(result.state, 'applied');
  assert.deepEqual(
    [result.created, result.updated, result.unchanged, result.relations],
    [31, 0, 0, 51],
  );
  assert.equal((await mine(IDS.viewer)).length, 31);
  assert.equal((await mine(IDS.other)).length, 0, 'fajar has no grant on this category');
  // Deciding twice is refused.
  await assert.rejects(() => decideTaImport(IDS.super, id, 'reject', 'terlambat sekali'));
  const audit = await admin.query(
    'SELECT action FROM app.audit_events WHERE request_id=$1 ORDER BY id',
    [id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ['ta.import_submitted', 'ta.imported'],
  );
});

test('a rejection needs a reason and leaves the model as it was; the proposer can withdraw', async () => {
  const changed: TaParseResult = {
    ...parsed,
    elements: parsed.elements.map((e) =>
      e.name === 'srv-mon-01' ? { ...e, os: 'Rocky Linux' } : e,
    ),
  };
  const id = await propose(IDS.admin, changed);
  await assert.rejects(
    () => decideTaImport(IDS.super, id, 'reject', 'kurang'),
    /Prasyarat|reason/i,
  );
  await decideTaImport(IDS.super, id, 'reject', 'Belum ada tiket perubahan untuk migrasi OS ini.');
  assert.equal((await mine(IDS.viewer)).find((e) => e.name === 'srv-mon-01')!.os, 'CentOS');
  const again = await propose(IDS.admin, changed);
  await assert.rejects(
    () => decideTaImport(IDS.super, again, 'withdraw', null),
    /tidak tersedia|Unavailable/i,
    'only the proposer withdraws',
  );
  await decideTaImport(IDS.admin, again, 'withdraw', null);
});

test('an approved change updates in place, records the fields, and drops relations the model no longer draws', async () => {
  const changed: TaParseResult = {
    ...parsed,
    elements: parsed.elements.map((e) =>
      e.name === 'srv-mon-01'
        ? { ...e, os: 'Rocky Linux', osVersion: '9.4', endOfSupport: '2032-05-31' }
        : e,
    ),
    relations: parsed.relations.filter(
      (r) =>
        !(
          r.kind === 'depends_on' &&
          parsed.elements.find((e) => e.externalId === r.targetExternalId)?.name === 'PostgreSQL 13'
        ),
    ),
  };
  const { diff, updated } = await diffTaImport(IDS.admin, category, changed);
  assert.equal(updated, 1);
  assert.deepEqual(diff[0]!.fields.os, ['CentOS', 'Rocky Linux']);
  const s = await decideTaImport(IDS.super, await propose(IDS.admin, changed), 'approve', null);
  assert.deepEqual([s.updated, s.relationsRemoved], [1, 1]);
  const mon = (await mine(IDS.viewer)).find((e) => e.name === 'srv-mon-01')!;
  assert.deepEqual([mon.os, mon.osVersion, mon.endOfSupport], ['Rocky Linux', '9.4', '2032-05-31']);
  const history = await taElementChanges(IDS.viewer, mon.id);
  assert.equal(history[0]!.change, 'updated');
  assert.deepEqual(history[0]!.fields.os, ['CentOS', 'Rocky Linux']);
  assert.equal(history[0]!.approvedBy, 'Budi Hartono');
  assert.equal(history.at(-1)!.change, 'created');
  // An element missing from a later export is reported, never deleted.
  const partial = await decideTaImport(
    IDS.super,
    await propose(IDS.admin, { ...parsed, elements: parsed.elements.slice(0, 5), relations: [] }),
    'approve',
    null,
  );
  assert.equal(partial.notInImport, 26);
  assert.equal((await mine(IDS.viewer)).length, 31);
});

test('nothing but the functions writes: the app role, the worker and a forged scan are refused', async () => {
  const app = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    await assert.rejects(
      () => app.query("UPDATE app.ta_elements SET name='x'"),
      /permission denied/,
    );
    await assert.rejects(
      () => app.query("UPDATE app.ta_imports SET state='applied'"),
      /permission denied/,
    );
  } finally {
    await app.end();
  }
  await assert.rejects(() => worker.query('SELECT 1 FROM app.ta_elements'), /permission denied/);
  const snap = await worker.query(
    'SELECT jsonb_array_length(elements) AS n FROM app.ta_index_snapshot()',
  );
  assert(snap.rows[0].n >= 31);
  const sha = 'c'.repeat(64);
  await assert.rejects(
    () =>
      submitTaImport(IDS.admin, {
        categoryId: category,
        parsed,
        diff: [],
        filename: 'x.xmi',
        format: 'xmi',
        sha256: sha,
        blobKey: 'ta-imports/x/original.xmi',
        scan: { verdict: 'clean', sha256: 'd'.repeat(64) },
      }),
    /Prasyarat|invalid/i,
    'scan evidence must be for this file',
  );
});
