// S10/V1 · knowledge gaps. The point of these tests is the privacy boundary, not the
// aggregation: a term must be unreachable until enough distinct people searched it, and
// the stored wording must never include something that identifies a person.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';

const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const term = 'istilah uji gap';

async function record(actor: string, raw: string, results = 0) {
  await db.query(
    'INSERT INTO app.search_events(actor_id,result_count,duration_ms,query_norm) VALUES($1,$2,10,app.normalise_query($3))',
    [actor, results, raw],
  );
}
async function gaps(days = 30, unit: string | null = null) {
  const r = await db.query<{ term: string; searches: string; people: string }>(
    'SELECT term,searches,people FROM app.knowledge_gaps($1,$2)',
    [days, unit],
  );
  return r.rows;
}

before(async () => {
  await db.query("DELETE FROM app.search_events WHERE query_norm LIKE 'istilah uji%'");
});
after(async () => {
  await db.query("DELETE FROM app.search_events WHERE query_norm LIKE 'istilah uji%'");
  await db.end();
});

test('normalisation drops anything that could identify a person', async () => {
  for (const raw of ['pesan ke budi@example.test', 'token 1234567890123', 'z'.repeat(45), 'ab']) {
    const r = await db.query<{ n: string | null }>('SELECT app.normalise_query($1) AS n', [raw]);
    assert.equal(r.rows[0]!.n, null, `harus dibuang: ${raw}`);
  }
});

test('the same search typed with different spacing aggregates as one term', async () => {
  const a = await db.query<{ n: string }>('SELECT app.normalise_query($1) AS n', [
    '  VPN,   Windows!  ',
  ]);
  const b = await db.query<{ n: string }>('SELECT app.normalise_query($1) AS n', ['vpn windows']);
  assert.equal(a.rows[0]!.n, b.rows[0]!.n);
});

test('one person searching repeatedly never becomes a reported gap', async () => {
  for (let i = 0; i < 12; i += 1) await record(IDS.viewer, term);
  const found = (await gaps()).find((g) => g.term === term);
  assert.equal(found, undefined, 'dua belas pencarian oleh satu orang tetap tidak boleh muncul');
});

test('two distinct people are still below the threshold', async () => {
  await record(IDS.other, term);
  const found = (await gaps()).find((g) => g.term === term);
  assert.equal(found, undefined);
});

test('a third distinct person brings the term above the threshold', async () => {
  await record(IDS.contributor, term);
  const found = (await gaps()).find((g) => g.term === term);
  assert(found, 'tiga orang berbeda harus melewati ambang');
  assert.equal(Number(found.people), 3);
  assert(Number(found.searches) >= 14);
});

test('the threshold cannot be lowered by the caller', async () => {
  // The function takes min_actors, but clamps it: asking for 1 must not expose a term
  // that only one or two people searched.
  await db.query("DELETE FROM app.search_events WHERE query_norm='istilah uji rahasia'");
  await record(IDS.viewer, 'istilah uji rahasia');
  const r = await db.query<{ term: string }>('SELECT term FROM app.knowledge_gaps($1,$2,$3)', [
    30,
    null,
    1,
  ]);
  assert(
    !r.rows.some((g) => g.term === 'istilah uji rahasia'),
    'min_actors=1 tidak boleh menembus ambang',
  );
});

test('a search that found results is not a gap', async () => {
  await db.query("DELETE FROM app.search_events WHERE query_norm='istilah uji berhasil'");
  for (const actor of [IDS.viewer, IDS.other, IDS.contributor])
    await record(actor, 'istilah uji berhasil', 5);
  assert(!(await gaps()).some((g) => g.term === 'istilah uji berhasil'));
});

test('retention clears the wording but keeps the counted event', async () => {
  await db.query(
    "UPDATE app.search_events SET created_at=now()-interval '40 days' WHERE query_norm=$1",
    [term],
  );
  const before = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.search_events WHERE created_at<now()-interval '40 days' + interval '1 day'",
  );
  await db.query('SELECT app.prune_search_queries()');
  const stillThere = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.search_events WHERE created_at<now()-interval '39 days'",
  );
  assert.equal(stillThere.rows[0]!.n, before.rows[0]!.n, 'barisnya tetap ada untuk KPI');
  const wording = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.search_events WHERE query_norm=$1',
    [term],
  );
  assert.equal(wording.rows[0]!.n, '0', 'teksnya harus hilang setelah 30 hari');
});
