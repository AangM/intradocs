/**
 * Migration 042. Through the worker role: the hourly policy pass archives an expired,
 * unreplaced document with the reason on record, leaves one whose replacement is under
 * way alone, and escalates a long-overdue review to the category's administrators once.
 * Through an actor: the owner can reaffirm a due review, nobody else can, and an expired
 * or not-yet-due version is refused.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { localAdminUrl, loadLocalEnv } from '../../scripts/shared.ts';
import { withActor, closePools } from '../../packages/db/src/index.ts';
import { IDS, docId } from '../../fixtures/data.ts';

loadLocalEnv();
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL!, max: 1 });
const expiredDoc = docId(10); // fixture: expired 2019-12-31, never withdrawn
const liveDoc = docId(2); // fixture: published, review in 2027, owned by rizky

async function currentVersion(doc: string) {
  const { rows } = await admin.query(
    'SELECT v.id, v.review_at, v.expires_at, v.publication_state, v.withdrawal_reason, d.withdrawn FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE d.id=$1',
    [doc],
  );
  return rows[0] as {
    id: string;
    review_at: Date;
    expires_at: Date | null;
    publication_state: string;
    withdrawal_reason: string | null;
    withdrawn: boolean;
  };
}
async function restore() {
  // Put both fixture documents back exactly as seeded.
  await admin.query('UPDATE app.documents SET withdrawn=false WHERE id=ANY($1)', [
    [expiredDoc, liveDoc],
  ]);
  await admin.query(
    "UPDATE app.document_versions SET publication_state='published', withdrawal_reason=NULL WHERE id IN (SELECT current_version_id FROM app.documents WHERE id=ANY($1))",
    [[expiredDoc, liveDoc]],
  );
  await admin.query("DELETE FROM app.document_versions WHERE document_id=$1 AND label='9.9'", [
    expiredDoc,
  ]);
  await admin.query(
    "UPDATE app.document_versions SET review_at='2027-02-10T00:00:00Z' WHERE id=(SELECT current_version_id FROM app.documents WHERE id=$1)",
    [liveDoc],
  );
  await admin.query(
    "DELETE FROM app.notifications WHERE kind IN ('archived','review_overdue') AND version_id IN (SELECT current_version_id FROM app.documents WHERE id=ANY($1))",
    [[expiredDoc, liveDoc]],
  );
  await admin.query(
    "DELETE FROM app.audit_events WHERE action IN ('document.archived_by_policy','document.reaffirmed') AND document_id=ANY($1)",
    [[expiredDoc, liveDoc]],
  );
}
before(restore);
after(async () => {
  await restore();
  await admin.end();
  await worker.end();
  await closePools();
});

const apply = (grace = 30, overdue = 30) =>
  worker
    .query('SELECT * FROM app.apply_retention($1,$2)', [grace, overdue])
    .then((r) => r.rows[0] as { archived: number; escalated: number });

test('the worker role runs the policy and can read nothing else', async () => {
  await assert.rejects(
    () => worker.query('SELECT 1 FROM app.documents LIMIT 1'),
    /permission denied/,
  );
  await assert.rejects(() => worker.query('SELECT * FROM app.apply_retention(0,30)'), /invalid/i);
});

test('an expired document with a replacement under way is left to its owner', async () => {
  const v = await currentVersion(expiredDoc);
  await admin.query(
    `INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,byte_size,source_format,title,summary,category_id,classification,labels,author_id,version_number,processing_state,publication_state,created_at)
     SELECT public.gen_random_uuid(),document_id,'9.9','draft',markdown_key||'.test-draft',markdown_sha256,byte_size,source_format,title,summary,category_id,classification,labels,author_id,version_number+1,'preview_ready','unpublished',now()
     FROM app.document_versions WHERE id=$1`,
    [v.id],
  );
  const r = await apply();
  assert.equal(r.archived, 0, 'a draft newer than the expired version holds the policy off');
  assert.equal((await currentVersion(expiredDoc)).withdrawn, false);
  await admin.query("DELETE FROM app.document_versions WHERE document_id=$1 AND label='9.9'", [
    expiredDoc,
  ]);
});

test('an expired, unreplaced document is archived by policy: withdrawn, reason on record, owner told', async () => {
  const r = await apply(30, 30);
  assert.equal(r.archived, 1);
  const v = await currentVersion(expiredDoc);
  assert.equal(v.withdrawn, true);
  assert.equal(v.publication_state, 'withdrawn');
  assert.match(v.withdrawal_reason ?? '', /kebijakan retensi.*(2019-12-31|2020-01-01).*30 hari/);
  const audit = await admin.query(
    "SELECT actor_id FROM app.audit_events WHERE action='document.archived_by_policy' AND document_id=$1",
    [expiredDoc],
  );
  assert.deepEqual(audit.rows, [{ actor_id: IDS.contributor }]);
  const note = await admin.query(
    "SELECT user_id FROM app.notifications WHERE kind='archived' AND version_id=$1",
    [v.id],
  );
  assert.deepEqual(note.rows, [{ user_id: IDS.contributor }]);
  // Idempotent: a second pass finds nothing.
  assert.equal((await apply(30, 30)).archived, 0);
  // And the reader sees a withdrawal, like a manual one.
  const seen = await withActor(IDS.viewer, ({ client }) =>
    client.query('SELECT 1 FROM app.documents WHERE id=$1 AND app.can_read_document(id)', [
      expiredDoc,
    ]),
  );
  assert.equal(seen.rowCount, 0);
});

test('a review overdue past the window is escalated to the category administrators, once per date', async () => {
  const v = await currentVersion(liveDoc);
  await admin.query(
    "UPDATE app.document_versions SET review_at=now()-interval '45 days' WHERE id=$1",
    [v.id],
  );
  assert.equal((await apply(30, 60)).escalated, 0, 'inside a 60-day window nothing is escalated');
  const r = await apply(30, 30);
  assert(r.escalated >= 1, `escalated ${r.escalated}`);
  const who = await admin.query(
    "SELECT user_id FROM app.notifications WHERE kind='review_overdue' AND version_id=$1 ORDER BY user_id",
    [v.id],
  );
  const ids = who.rows.map((x) => x.user_id as string);
  // Budi (super admin, global) and Andi (knowledge admin over Infrastruktur), never the owner.
  assert(ids.includes(IDS.super) && ids.includes(IDS.admin), `admins: ${ids}`);
  assert(!ids.includes(IDS.contributor));
  assert.equal((await apply(30, 30)).escalated, 0, 'the same date is not escalated twice');
});

test('the owner reaffirms a due review; the date moves by the category cadence and the reminder clears', async () => {
  const v = await currentVersion(liveDoc);
  const before = v.review_at.getTime();
  assert(before < Date.now(), 'still overdue from the previous test');
  const { rows } = await withActor(IDS.contributor, ({ client }) =>
    client.query('SELECT app.reaffirm_version($1) AS next', [v.id]),
  );
  const next = (rows[0].next as Date).getTime();
  const cadence = (
    await admin.query('SELECT review_days FROM app.categories WHERE id=$1', [IDS.infra])
  ).rows[0].review_days as number;
  assert(Math.abs(next - (Date.now() + cadence * 86_400_000)) < 60_000, 'today + review_days');
  const unread = await admin.query(
    "SELECT count(*)::int AS n FROM app.notifications WHERE version_id=$1 AND kind='review_overdue' AND read_at IS NULL",
    [v.id],
  );
  assert.equal(unread.rows[0].n, 0, 'the escalation is marked read by the reaffirmation');
  const audit = await admin.query(
    "SELECT actor_id FROM app.audit_events WHERE action='document.reaffirmed' AND document_id=$1",
    [liveDoc],
  );
  assert.deepEqual(audit.rows, [{ actor_id: IDS.contributor }]);
  // Now it is a year out: reaffirming again is refused as not due.
  await assert.rejects(
    () =>
      withActor(IDS.contributor, ({ client }) =>
        client.query('SELECT app.reaffirm_version($1)', [v.id]),
      ),
    /not due/,
  );
});

test('only the owner can reaffirm, and an expired version cannot be', async () => {
  const v = await currentVersion(liveDoc);
  await admin.query(
    "UPDATE app.document_versions SET review_at=now()+interval '5 days' WHERE id=$1",
    [v.id],
  );
  for (const other of [IDS.super, IDS.admin, IDS.reviewer, IDS.viewer])
    await assert.rejects(
      () =>
        withActor(other, ({ client }) => client.query('SELECT app.reaffirm_version($1)', [v.id])),
      /Unavailable|permission/,
    );
  const gone = await currentVersion(expiredDoc);
  await admin.query('UPDATE app.documents SET withdrawn=false WHERE id=$1', [expiredDoc]);
  await admin.query(
    "UPDATE app.document_versions SET publication_state='published', withdrawal_reason=NULL WHERE id=$1",
    [gone.id],
  );
  await assert.rejects(
    () =>
      withActor(IDS.contributor, ({ client }) =>
        client.query('SELECT app.reaffirm_version($1)', [gone.id]),
      ),
    /expired/,
  );
});
