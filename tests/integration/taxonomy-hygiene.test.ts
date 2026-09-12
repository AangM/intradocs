// V1/S07 · saran perapian taksonomi. Real PostgreSQL/RLS.
//
// The property under test: "unused" means unused by any active version, not by the
// versions the admin happens to be able to read -- otherwise a label carried only by a
// restricted document would be offered for deletion. And nothing here crosses the
// admin's category scope.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { closePools } from '../../packages/db/src/index.ts';
import { taxonomySuggestions } from '../../packages/db/src/taxonomy.ts';
import { IDS } from '../../fixtures/data.ts';

const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
after(async () => {
  await admin.end();
  await closePools();
});

test('a label used only by a document the admin cannot read is not called unused', async () => {
  // Kritikal in Keamanan Informasi rides on the confidential fixture, which the knowledge
  // admin has no grant for. The counting function still sees it.
  const { rows } = await admin.query<{ id: string }>(
    "SELECT l.id FROM app.labels l WHERE l.name='Kritikal' AND l.category_id=$1",
    [IDS.security],
  );
  const kritikalSecurity = rows[0]?.id;
  assert(kritikalSecurity, 'fixture label missing');
  const s = await taxonomySuggestions(IDS.admin);
  assert(!s.unused.some((u) => u.id === kritikalSecurity), 'hidden usage must still count');
});

test('a label carried only by a draft is unused, and reported with its category', async () => {
  const s = await taxonomySuggestions(IDS.admin);
  const runbookData = s.unused.find((u) => u.name === 'Runbook' && u.categoryId === IDS.data);
  assert(runbookData, 'Runbook in Data & Integrasi is only on a draft');
  assert.equal(runbookData.categoryName, 'Data & Integrasi');
  // The same name in Infrastruktur is in use and must not be listed.
  assert(!s.unused.some((u) => u.name === 'Runbook' && u.categoryId === IDS.infra));
});

test('near-duplicate names are suggested within one category and applied only by hand', async () => {
  const inserted = await admin.query<{ id: string }>(
    "INSERT INTO app.labels(category_id,name) VALUES($1,'Runbooks') RETURNING id",
    [IDS.infra],
  );
  try {
    const s = await taxonomySuggestions(IDS.admin);
    const pair = s.duplicates.find(
      (d) => [d.a.name, d.b.name].includes('Runbooks') && [d.a.name, d.b.name].includes('Runbook'),
    );
    assert(pair, 'Runbook / Runbooks should be flagged');
    assert.equal(pair.categoryId, IDS.infra);
    assert(pair.nameSimilarity >= 0.45);
    // Suggesting changed nothing.
    const still = await admin.query('SELECT merged_into FROM app.labels WHERE id=$1', [
      inserted.rows[0]!.id,
    ]);
    assert.equal(still.rows[0]!.merged_into, null);
  } finally {
    await admin.query('DELETE FROM app.labels WHERE id=$1', [inserted.rows[0]!.id]);
  }
});

test('a viewer without taxonomy scope sees no suggestions about other categories', async () => {
  // fajar only has SOP & Proses Bisnis; nothing from Infrastruktur or Data may appear.
  const s = await taxonomySuggestions(IDS.other);
  for (const u of s.unused) assert.equal(u.categoryId, IDS.sop, `leaked ${u.categoryName}`);
  for (const d of s.duplicates) assert.equal(d.categoryId, IDS.sop);
});
