/**
 * Migration 041 as the worker sees it: through the worker role, with the three
 * SECURITY DEFINER functions and nothing else. What is proven: a burst of one person's
 * notifications becomes one digest once it has settled; a person who switched email off
 * is never claimed; a failed send counts an attempt and gives up after the limit; and
 * stale items are retired unsent.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl, loadLocalEnv } from '../../scripts/shared.ts';
import { IDS, versionId } from '../../fixtures/data.ts';

loadLocalEnv();
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL!, max: 1 });
const KEY = 'test-digest:';

async function seed(user: string, n: number, ageSeconds: number, tag = 'a') {
  for (let i = 0; i < n; i++)
    await admin.query(
      `INSERT INTO app.notifications(user_id,version_id,kind,event_key,created_at)
       VALUES($1,$2,'feedback',$3,now()-($4||' seconds')::interval) ON CONFLICT DO NOTHING`,
      [user, versionId(1), `${KEY}${user}:${tag}:${i}`, String(ageSeconds)],
    );
}
async function cleanup() {
  await admin.query('DELETE FROM app.notifications WHERE event_key LIKE $1', [`${KEY}%`]);
  await admin.query('UPDATE app.profiles SET email_notifications=true WHERE id=ANY($1)', [
    [IDS.viewer, IDS.other],
  ]);
}
before(async () => {
  await cleanup();
  // Whatever the database already holds (demo content, earlier runs) predates mail:
  // retire it so the queue starts empty and this file's rows are the only ones due.
  await worker.query("SELECT app.retire_stale_email('0 seconds'::interval)");
});
after(async () => {
  await cleanup();
  await admin.end();
  await worker.end();
});

const claim = (settle = '2 minutes', attempts = 5) =>
  worker.query('SELECT * FROM app.claim_email_digest($1::interval,$2)', [settle, attempts]).then(
    (r) =>
      r.rows as Array<{
        user_id: string;
        email: string;
        items: Array<{ id: string; kind: string; title: string }>;
      }>,
  );

test('the worker role can reach the digest functions and nothing else about notifications', async () => {
  await assert.rejects(
    () => worker.query('SELECT 1 FROM app.notifications LIMIT 1'),
    /permission denied/,
  );
  await assert.rejects(
    () => worker.query('SELECT email FROM app.profiles LIMIT 1'),
    /permission denied/,
  );
  assert.deepEqual(await claim(), []);
});

test('a burst becomes one digest per person, only once it has settled', async () => {
  await seed(IDS.viewer, 3, 10);
  assert.deepEqual(await claim('2 minutes'), [], 'ten seconds old: still settling');
  const rows = await claim('5 seconds');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_id, IDS.viewer);
  assert.equal(rows[0]!.email, 'siti@example.test');
  assert.equal(rows[0]!.items.length, 3);
  assert.equal(rows[0]!.items[0]!.kind, 'feedback');
  assert(rows[0]!.items[0]!.title.length > 0, 'the title comes with the item');
  // Claiming does not consume: the same digest comes back until it is settled.
  assert.equal((await claim('5 seconds'))[0]!.items.length, 3);
  const ids = rows[0]!.items.map((i) => i.id);
  await worker.query('SELECT app.settle_email_digest($1::uuid[],true)', [ids]);
  assert.deepEqual(await claim('5 seconds'), []);
  const { rows: marked } = await admin.query(
    'SELECT count(*)::int AS n FROM app.notifications WHERE event_key LIKE $1 AND emailed_at IS NOT NULL',
    [`${KEY}%`],
  );
  assert.equal(marked[0].n, 3);
});

test('a person who turned email off is never claimed, and the bell is untouched', async () => {
  await admin.query('UPDATE app.profiles SET email_notifications=false WHERE id=$1', [IDS.other]);
  await seed(IDS.other, 2, 600);
  assert.deepEqual(await claim('5 seconds'), []);
  const { rows } = await admin.query(
    'SELECT count(*)::int AS n FROM app.notifications WHERE user_id=$1 AND event_key LIKE $2 AND read_at IS NULL',
    [IDS.other, `${KEY}%`],
  );
  assert.equal(rows[0].n, 2, 'still unread in the portal');
  await admin.query('UPDATE app.profiles SET email_notifications=true WHERE id=$1', [IDS.other]);
  assert.equal((await claim('5 seconds')).length, 1, 'switching back on releases them');
  await admin.query('DELETE FROM app.notifications WHERE user_id=$1 AND event_key LIKE $2', [
    IDS.other,
    `${KEY}%`,
  ]);
});

test('a failed send counts an attempt; after the limit the items are retired, not retried forever', async () => {
  await seed(IDS.viewer, 1, 600, 'fail');
  const [d] = await claim('5 seconds');
  const ids = d!.items.map((i) => i.id);
  for (let i = 0; i < 3; i++)
    await worker.query('SELECT app.settle_email_digest($1::uuid[],false)', [ids]);
  const { rows } = await admin.query(
    'SELECT email_attempts, emailed_at FROM app.notifications WHERE id=$1',
    [ids[0]],
  );
  assert.equal(rows[0].email_attempts, 3);
  assert.equal(rows[0].emailed_at, null);
  assert.equal((await claim('5 seconds', 5)).length, 1, 'under the limit: still offered');
  assert.deepEqual(await claim('5 seconds', 3), [], 'at the limit: retired on the next claim');
  const after = await admin.query('SELECT emailed_at FROM app.notifications WHERE id=$1', [ids[0]]);
  assert.notEqual(after.rows[0].emailed_at, null);
});

test('stale items are retired unsent so switching mail on later releases no backlog', async () => {
  await seed(IDS.viewer, 2, 3 * 86400, 'stale');
  const { rows } = await worker.query('SELECT app.retire_stale_email($1::interval) AS n', [
    '1 day',
  ]);
  assert(rows[0].n >= 2);
  assert.deepEqual(await claim('5 seconds'), []);
});
