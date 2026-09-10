import test from 'node:test';
import assert from 'node:assert/strict';
import { runActorTransaction, type TransactionClient } from '../../packages/db/src/transaction.ts';
function fake(failing: string[] = []) {
  const calls: string[] = [];
  let discarded: boolean | undefined;
  const errors = new Map(failing.map((k) => [k, new Error(k)]));
  const client: TransactionClient = {
    async query(sql, values) {
      calls.push(sql);
      if (errors.has(sql)) throw errors.get(sql)!;
      if (sql.includes('set_config')) assert.deepEqual(values, ['synthetic-actor']);
      return {};
    },
    release(destroy) {
      calls.push('release');
      discarded = destroy;
    },
  };
  return { client, calls, errors, discarded: () => discarded };
}
test('scoped transaction sets actor locally, commits once and releases cleanly', async () => {
  const f = fake();
  assert.equal(await runActorTransaction(f.client, 'synthetic-actor', async () => 42), 42);
  assert.deepEqual(f.calls, [
    'BEGIN',
    "SELECT set_config('app.actor_id',$1,true)",
    "SET LOCAL statement_timeout='5s'",
    'COMMIT',
    'release',
  ]);
  assert.equal(f.discarded(), false);
});
test('callback error rolls back and keeps the exact original error', async () => {
  const f = fake(),
    error = new Error('original');
  await assert.rejects(
    runActorTransaction(f.client, 'synthetic-actor', async () => {
      throw error;
    }),
    (e) => e === error,
  );
  assert(f.calls.includes('ROLLBACK'));
  assert.equal(f.discarded(), false);
});
test('failed rollback destroys the connection instead of leaking a transaction into the pool', async () => {
  const f = fake(['ROLLBACK']),
    error = new Error('original');
  await assert.rejects(
    runActorTransaction(f.client, 'synthetic-actor', async () => {
      throw error;
    }),
    (e) => e === error,
  );
  assert.equal(f.discarded(), true);
  assert.equal(f.calls.at(-1), 'release');
});
test('ambiguous COMMIT is never retried and the connection is destroyed', async () => {
  const f = fake(['COMMIT']);
  await assert.rejects(
    runActorTransaction(f.client, 'synthetic-actor', async () => 42),
    (e) => e === f.errors.get('COMMIT'),
  );
  assert.equal(f.calls.filter((x) => x === 'COMMIT').length, 1);
  assert.equal(f.discarded(), true);
});
test('BEGIN failure releases a broken connection without a fake rollback', async () => {
  const f = fake(['BEGIN']);
  await assert.rejects(runActorTransaction(f.client, 'synthetic-actor', async () => 42));
  assert.deepEqual(f.calls, ['BEGIN', 'release']);
  assert.equal(f.discarded(), true);
});
