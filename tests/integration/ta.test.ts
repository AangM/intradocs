/**
 * Migration 045 through the actor, in a throwaway category: who may import, who may see,
 * what a re-import changes, and that the worker's snapshot is the only other way in.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { localAdminUrl, loadLocalEnv } from '../../scripts/shared.ts';
import { closePools } from '../../packages/db/src/index.ts';
import { applyTaImport, previewTaImport, taModel } from '../../packages/db/src/ta.ts';
import { parseSparxXmi, type TaParseResult } from '../../packages/core/src/ta.ts';
import { IDS } from '../../fixtures/data.ts';

loadLocalEnv();
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL!, max: 1 });
const category = randomUUID();
const parsed = parseSparxXmi(readFileSync('fixtures/ta/sparx-technology-demo.xmi', 'utf8'));
const sha = 'a'.repeat(64);
const input = (p: TaParseResult = parsed) => ({
  categoryId: category,
  parsed: p,
  filename: 'uji.xmi',
  format: 'xmi' as const,
  sha256: sha,
});

before(async () => {
  await admin.query(
    "INSERT INTO app.categories(id,name,description) VALUES($1,'Uji TA '||$2,'Kategori sementara untuk tes TA')",
    [category, category.slice(0, 8)],
  );
  // siti (viewer) reads it; fajar (viewer, SOP only) does not; rizky (contributor) reads but may not import.
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
  await admin.query(
    "DELETE FROM app.audit_events WHERE action='ta.imported' AND created_at > now() - interval '1 hour' AND actor_id=$1",
    [IDS.admin],
  );
  await admin.end();
  await worker.end();
  await closePools();
});

test('only a knowledge or super admin in scope imports; readers, contributors and outsiders are refused', async () => {
  for (const who of [IDS.viewer, IDS.contributor, IDS.other, IDS.reviewer])
    await assert.rejects(
      () => applyTaImport(who, input()),
      /tidak tersedia|Unavailable/i,
      `${who} must not import`,
    );
  const summary = await applyTaImport(IDS.admin, input());
  assert.deepEqual([summary.created, summary.updated, summary.unchanged], [31, 0, 0]);
  assert.equal(summary.relations, 51);
  assert.equal(summary.skipped.length, 1, 'the business actor');
  const audit = await admin.query(
    "SELECT count(*)::int AS n FROM app.audit_events WHERE action='ta.imported' AND actor_id=$1",
    [IDS.admin],
  );
  assert(audit.rows[0].n >= 1);
});

test('the model is visible exactly where the category is: siti yes, fajar no', async () => {
  const siti = await taModel(IDS.viewer);
  const mine = siti.elements.filter((e) => e.categoryId === category);
  assert.equal(mine.length, 31);
  assert(siti.relations.length >= 51);
  const fajar = await taModel(IDS.other);
  assert.equal(fajar.elements.filter((e) => e.categoryId === category).length, 0);
  assert.equal(fajar.relations.filter((r) => mine.some((e) => e.id === r.sourceId)).length, 0);
});

test('a re-import is a no-op; a changed model updates in place and drops the relations it no longer draws', async () => {
  const again = await applyTaImport(IDS.admin, input());
  assert.deepEqual(
    [again.created, again.updated, again.unchanged, again.relationsRemoved],
    [0, 0, 31, 0],
  );
  assert.deepEqual(await previewTaImport(IDS.admin, category, parsed), {
    created: 0,
    updated: 0,
    unchanged: 31,
  });
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
  assert.deepEqual(await previewTaImport(IDS.admin, category, changed), {
    created: 0,
    updated: 1,
    unchanged: 30,
  });
  const s = await applyTaImport(IDS.admin, input(changed));
  assert.deepEqual([s.updated, s.relationsRemoved], [1, 1]);
  const mon = (await taModel(IDS.viewer)).elements.find(
    (e) => e.categoryId === category && e.name === 'srv-mon-01',
  )!;
  assert.deepEqual([mon.os, mon.osVersion, mon.endOfSupport], ['Rocky Linux', '9.4', '2032-05-31']);
  // An element dropped from the export is reported, never deleted.
  const partial = await applyTaImport(
    IDS.admin,
    input({ ...parsed, elements: parsed.elements.slice(0, 5), relations: [] }),
  );
  assert.equal(partial.notInImport, 26);
  assert.equal(
    (await taModel(IDS.viewer)).elements.filter((e) => e.categoryId === category).length,
    31,
  );
});

test('the app role cannot write the tables directly; the worker sees only the snapshot', async () => {
  const app = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    await assert.rejects(
      () => app.query("UPDATE app.ta_elements SET name='x'"),
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
});
