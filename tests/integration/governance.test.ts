import { dashboardData, relatedDocuments } from '../../packages/db/src/discovery.ts';
// PostgreSQL authorization/governance, no UI-only permission claims.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { localAdminUrl } from '../../scripts/shared.ts';
import { withActor, closePools } from '../../packages/db/src/index.ts';
import {
  saveCategory,
  deleteCategory,
  saveLabel,
  assignUser,
  taxonomyData,
} from '../../packages/db/src/taxonomy.ts';
import { IDS } from '../../fixtures/data.ts';
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const ids: string[] = [];
let parent: string, child: string, grandchild: string, labelId: string;
const input = (name: string, parentId: string | null = null) => ({
  id: null,
  revision: 0,
  parentId,
  name,
  description: 'Synthetic governance test',
  minimumClassification: 'internal' as const,
  approvalSteps: 1 as const,
  reviewDays: 180,
  position: 0,
  confirmTightening: false,
});
before(async () => {
  parent = await saveCategory(IDS.super, input('Test ' + randomUUID().slice(0, 8)));
  ids.push(parent);
});
after(async () => {
  try {
    await admin.query('DELETE FROM app.labels WHERE category_id=ANY($1::uuid[])', [ids]);
    await admin.query('DELETE FROM app.categories WHERE id=ANY($1::uuid[])', [ids]);
  } finally {
    await closePools();
    await admin.end();
  }
});
test('taxonomy mutation denies contributor even if page/scope was forged', async () => {
  await assert.rejects(saveCategory(IDS.contributor, input('Forbidden category', IDS.infra)));
});
test('category tree supports three levels and rejects a fourth or cycle', async () => {
  child = await saveCategory(IDS.super, input('Child ' + randomUUID().slice(0, 8), parent));
  ids.push(child);
  grandchild = await saveCategory(
    IDS.super,
    input('Grandchild ' + randomUUID().slice(0, 8), child),
  );
  ids.push(grandchild);
  await assert.rejects(saveCategory(IDS.super, input('Too deep category', grandchild)));
  const actual = (await taxonomyData(IDS.super)).categories.find((c) => c.id === parent)!;
  await assert.rejects(
    saveCategory(IDS.super, {
      ...actual,
      id: parent,
      parentId: grandchild,
      minimumClassification: 'internal',
      approvalSteps: 1,
      confirmTightening: false,
    }),
  );
});
test('tightening requires confirmation, lowering and stale editor updates are refused', async () => {
  const item = (await taxonomyData(IDS.super)).categories.find((c) => c.id === grandchild)!;
  const update = {
    ...item,
    id: grandchild,
    minimumClassification: 'restricted' as const,
    approvalSteps: 2 as const,
    confirmTightening: false,
  };
  await assert.rejects(saveCategory(IDS.super, update));
  await saveCategory(IDS.super, { ...update, confirmTightening: true });
  await assert.rejects(saveCategory(IDS.super, { ...update, confirmTightening: true }));
  await assert.rejects(
    saveCategory(IDS.super, {
      ...update,
      revision: item.revision + 1,
      minimumClassification: 'internal',
      confirmTightening: true,
    }),
  );
});
test('labels support create/edit/delete with revision checks and parent deletion respects references', async () => {
  labelId = await saveLabel(IDS.super, {
    id: null,
    revision: 0,
    categoryId: child,
    name: 'TestLabel',
    color: 'blue',
    remove: false,
  });
  await assert.rejects(deleteCategory(IDS.super, parent, 1));
  await saveLabel(IDS.super, {
    id: labelId,
    revision: 1,
    categoryId: child,
    name: 'TestLabelNew',
    color: 'green',
    remove: false,
  });
  await assert.rejects(
    saveLabel(IDS.super, {
      id: labelId,
      revision: 1,
      categoryId: child,
      name: 'StaleLabel',
      color: 'green',
      remove: false,
    }),
  );
  await saveLabel(IDS.super, {
    id: labelId,
    revision: 2,
    categoryId: child,
    name: 'TestLabelNew',
    color: 'green',
    remove: true,
  });
});
test('role assignments reject self-escalation, knowledge-admin elevation and nonscoped users', async () => {
  await assert.rejects(
    assignUser(IDS.super, IDS.super, { role: 'viewer', scopeAll: false, categoryIds: [] }),
  );
  await assert.rejects(
    assignUser(IDS.admin, IDS.contributor, {
      role: 'super_admin',
      scopeAll: true,
      categoryIds: [],
    }),
  );
  await assert.rejects(
    assignUser(IDS.admin, IDS.other, { role: 'reviewer', scopeAll: false, categoryIds: [IDS.sop] }),
  );
});
test('worker and app cannot SET ROLE into mutation/policy owners or create schemas', async () => {
  await withActor(IDS.viewer, async ({ client }) => {
    await assert.rejects(client.query('SET LOCAL ROLE intradocs_workflow'));
  });
  const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
  try {
    await assert.rejects(worker.query('SELECT * FROM app.lexical_chunks'));
    await assert.rejects(worker.query('SELECT * FROM app.version_attachments'));
    await assert.rejects(worker.query('CREATE SCHEMA forbidden_test_schema'));
  } finally {
    await worker.end();
  }
});

test('unit-filtered KPIs and related documents remain RLS scoped', async () => {
  const all = await dashboardData(IDS.super, 30),
    none = await dashboardData(IDS.super, 30, 'missing-' + randomUUID());
  assert.equal(none.summary.active, 0);
  assert.equal(none.latest.length, 0);
  assert.equal(none.search.total, 0);
  const chosen = await dashboardData(IDS.super, 30, 'IT Operations');
  assert(chosen.summary.active <= all.summary.active);
  const related = await relatedDocuments(
    IDS.viewer,
    '20000000-0000-4000-8000-000000000001',
    IDS.infra,
  );
  assert(related.length <= 3);
  for (const d of related) {
    assert.notEqual(d.id, '20000000-0000-4000-8000-000000000001');
    assert(
      await withActor(
        IDS.viewer,
        async ({ client }) =>
          (await client.query('SELECT app.can_read_document($1) AS ok', [d.id])).rows[0].ok,
      ),
    );
  }
});
