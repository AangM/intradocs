// Real HTTP + Better Auth + PostgreSQL/RLS + ClamAV + converter + worker.
// Run only on the local synthetic dataset. No fake approvals or scanner verdicts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import { IDS } from '../../fixtures/data.ts';
import type { DemoAccount } from '../../scripts/seed.ts';
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const infra = '10000000-0000-4000-8000-000000000001';
const cookies = new Map<string, string>();
const documentIds: string[] = [];
const marker = 'WORKFLOW-' + randomUUID();
const sessions: string[] = [];
let published: { documentId: string; versionId: string; slug: string };
async function api(actor: string, route: string, body?: unknown, method = 'POST') {
  return fetch(base + route, {
    method,
    headers: {
      Cookie: cookies.get(actor) ?? '',
      Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function upload(
  options: {
    name?: string;
    labels?: string[];
    classification?: string;
    attachments?: string[];
    documentId?: string;
    baseVersionId?: string;
    text?: string;
  } = {},
) {
  const form = new FormData();
  const name = options.name ?? 'workflow.md';
  const bytes = options.text
    ? Buffer.from(options.text)
    : name === 'workflow.md'
      ? Buffer.from(`# Test workflow\n\n${marker} isi canonical tersembunyi sebelum approval.\n`)
      : await readFile(path.join(ROOT, 'fixtures/uploads', name));
  form.set(
    'file',
    new File([new Uint8Array(bytes)], name, {
      type: name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
    }),
  );
  for (const a of options.attachments ?? [])
    form.append(
      'attachments',
      new File([new Uint8Array(await readFile(path.join(ROOT, 'fixtures/uploads', a)))], a, {
        type: 'application/octet-stream',
      }),
    );
  for (const [k, v] of Object.entries({
    title: `Uji M3 ${randomUUID().slice(0, 8)}`,
    summary: 'Dokumen sintetis pengujian',
    categoryId: infra,
    classification: options.classification ?? 'internal',
    labels: JSON.stringify(options.labels ?? []),
    synthetic: 'true',
  }))
    form.set(k, v);
  if (options.documentId) {
    form.set('documentId', options.documentId);
    form.set('baseVersionId', options.baseVersionId!);
  }
  const r = await fetch(base + '/api/documents/drafts', {
    method: 'POST',
    headers: {
      Cookie: cookies.get(IDS.contributor)!,
      Origin: base,
      'Idempotency-Key': randomUUID(),
    },
    body: form,
  });
  const value = await r.json();
  assert.equal(r.status, 201, JSON.stringify(value));
  if (!documentIds.includes(value.documentId)) documentIds.push(value.documentId);
  return value as { documentId: string; versionId: string; slug: string };
}
async function submitted(vid: string, reviewers: string[] = [IDS.reviewer]) {
  const r = await api(IDS.contributor, `/api/versions/${vid}/submit`, {
    reviewers,
    confirmed: true,
  });
  assert.equal(r.status, 200, await r.text());
}
async function decision(actor: string, vid: string, action = 'approve', reason = '') {
  return api(actor, `/api/versions/${vid}/decision`, { decision: action, reason });
}
async function waitPublished(vid: string) {
  for (let i = 0; i < 50; i++) {
    const r = await db.query(
      'SELECT publication_state,processing_state FROM app.document_versions WHERE id=$1',
      [vid],
    );
    if (r.rows[0]?.publication_state === 'published') {
      assert.equal(r.rows[0].processing_state, 'ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const row = (
    await db.query('SELECT state,error_code FROM app.publication_outbox WHERE version_id=$1', [vid])
  ).rows[0];
  assert.fail('Publication did not complete: ' + JSON.stringify(row));
}
before(async () => {
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  for (const id of [IDS.contributor, IDS.reviewer, IDS.admin, IDS.super, IDS.viewer, IDS.other]) {
    await db.query('DELETE FROM auth."rateLimit"');
    const a = accounts.find((a) => a.id === id)!;
    const r = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    assert.equal(r.status, 200, 'Real login');
    const data = await r.json();
    if (data.token) sessions.push(data.token);
    cookies.set(
      id,
      r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    );
  }
  const assignment = await api(IDS.super, `/api/users/${IDS.reviewer}/assignment`, {
    role: 'reviewer',
    scopeAll: false,
    categoryIds: [IDS.security, IDS.infra],
  });
  assert.equal(assignment.status, 200, await assignment.text());
});
after(async () => {
  // Delete only rows created by this suite, never seed/user documents. Stored files remain GC-eligible.
  try {
    if (documentIds.length) {
      await db.query('BEGIN');
      await db.query('UPDATE app.documents SET current_version_id=NULL WHERE id=ANY($1::uuid[])', [
        documentIds,
      ]);
      for (const table of [
        'notifications',
        'version_findings',
        'lexical_chunks',
        'index_generations',
        'publication_outbox',
        'document_feedback',
        'read_history',
        'version_attachments',
      ])
        await db.query(
          `DELETE FROM app.${table} WHERE version_id IN(SELECT id FROM app.document_versions WHERE document_id=ANY($1::uuid[]))`,
          [documentIds],
        );
      await db.query(
        'DELETE FROM app.approval_steps WHERE request_id IN(SELECT id FROM app.approval_requests WHERE document_id=ANY($1::uuid[]))',
        [documentIds],
      );
      for (const table of [
        'approval_requests',
        'favorites',
        'audit_events',
        'document_grants',
        'review_assignments',
        'upload_requests',
      ])
        await db.query(`DELETE FROM app.${table} WHERE document_id=ANY($1::uuid[])`, [documentIds]);
      await db.query(
        'DELETE FROM app.version_sources WHERE version_id IN(SELECT id FROM app.document_versions WHERE document_id=ANY($1::uuid[]))',
        [documentIds],
      );
      await db.query('DELETE FROM app.document_versions WHERE document_id=ANY($1::uuid[])', [
        documentIds,
      ]);
      await db.query('DELETE FROM app.documents WHERE id=ANY($1::uuid[])', [documentIds]);
      await db.query('COMMIT');
    }
    await db.query('DELETE FROM app.category_grants WHERE user_id=$1 AND category_id=$2', [
      IDS.reviewer,
      IDS.infra,
    ]);
    await db.query('DELETE FROM auth.session WHERE token=ANY($1::text[])', [sessions]);
    await db.query('DELETE FROM auth."rateLimit"');
  } finally {
    await db.end();
  }
});
test('two-stage publication: private before final approval and indexed atomically', async () => {
  published = await upload({ labels: ['Kritikal'] });
  assert.equal(
    (await api(IDS.viewer, `/api/files/${published.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
  await submitted(published.versionId, [IDS.reviewer, IDS.admin]);
  assert.equal((await decision(IDS.contributor, published.versionId)).status, 403);
  assert.equal(
    (await decision(IDS.admin, published.versionId)).status,
    409,
    'Cannot skip first stage',
  );
  assert.equal((await decision(IDS.reviewer, published.versionId)).status, 200);
  assert.equal(
    (await api(IDS.viewer, `/api/files/${published.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
  const decisions = await Promise.all([
    decision(IDS.admin, published.versionId),
    decision(IDS.admin, published.versionId),
  ]);
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  await waitPublished(published.versionId);
  const r = await api(IDS.viewer, `/api/search?q=${encodeURIComponent(marker)}`, undefined, 'GET');
  assert.equal(r.status, 200);
  assert((await r.text()).includes(published.documentId));
  assert.equal(
    (await api(IDS.other, `/api/files/${published.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
  const count = await db.query(
    'SELECT count(*)::integer AS n FROM app.index_generations WHERE version_id=$1',
    [published.versionId],
  );
  assert.equal(count.rows[0].n, 1);
});
test('favorite, feedback and notification endpoints are personal and origin-protected', async () => {
  assert.equal(
    (await api(IDS.viewer, `/api/documents/${published.documentId}/favorite`, { favorite: true }))
      .status,
    200,
  );
  const catalog = await api(IDS.viewer, '/api/documents?view=favorites', undefined, 'GET');
  assert((await catalog.text()).includes(published.documentId));
  assert.equal(
    (
      await api(IDS.viewer, '/api/feedback', {
        versionId: published.versionId,
        helpful: false,
        comment: 'Mohon perjelas langkah audit.',
      })
    ).status,
    200,
  );
  const n = (
    await db.query(
      "SELECT id FROM app.notifications WHERE version_id=$1 AND user_id=$2 AND kind='feedback'",
      [published.versionId, IDS.contributor],
    )
  ).rows[0];
  assert(n);
  assert.equal((await api(IDS.viewer, `/api/notifications/${n.id}`, {})).status, 404);
  assert.equal((await api(IDS.contributor, `/api/notifications/${n.id}`, {})).status, 200);
  const bad = await fetch(base + `/api/documents/${published.documentId}/favorite`, {
    method: 'POST',
    headers: {
      Cookie: cookies.get(IDS.viewer)!,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: '{"favorite":false}',
  });
  assert.equal(bad.status, 400);
});
test('revision preserves active version, resets review, publishes only the new approved snapshot', async () => {
  const old = published;
  const revision = await upload({
    documentId: old.documentId,
    baseVersionId: old.versionId,
    text: `# Revision\n${marker}-REVISI`,
  });
  assert.equal(
    (await api(IDS.viewer, `/api/files/${revision.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
  assert.equal(
    (await api(IDS.viewer, `/api/files/${old.versionId}/markdown`, undefined, 'GET')).status,
    200,
  );
  await submitted(revision.versionId);
  assert.equal(
    (
      await decision(
        IDS.reviewer,
        revision.versionId,
        'changes_requested',
        'Tambahkan informasi validasi sumber.',
      )
    ).status,
    200,
  );
  assert.equal((await decision(IDS.reviewer, revision.versionId)).status, 409);
  const latest = await upload({
    documentId: old.documentId,
    baseVersionId: revision.versionId,
    text: `# Latest\n${marker}-FINAL`,
  });
  await submitted(latest.versionId);
  assert.equal((await decision(IDS.reviewer, latest.versionId)).status, 200);
  await waitPublished(latest.versionId);
  assert.equal(
    (await db.query('SELECT current_version_id FROM app.documents WHERE id=$1', [old.documentId]))
      .rows[0].current_version_id,
    latest.versionId,
  );
  assert.equal(
    (
      await db.query('SELECT publication_state FROM app.document_versions WHERE id=$1', [
        old.versionId,
      ])
    ).rows[0].publication_state,
    'superseded',
  );
  published = latest;
});
test('scan/convert/attachment manifest preserves original and includes locator-aware canonical text', async () => {
  const r = await upload({
    name: 'panduan-demo.pdf',
    attachments: ['panduan-demo.docx', 'sla-demo.xlsx', 'catatan-demo.txt'],
  });
  for (const kind of ['original', 'provenance', 'markdown'])
    assert.equal(
      (await api(IDS.contributor, `/api/files/${r.versionId}/${kind}`, undefined, 'GET')).status,
      200,
    );
  const original = await api(
    IDS.contributor,
    `/api/files/${r.versionId}/original`,
    undefined,
    'GET',
  );
  assert.deepEqual(
    Buffer.from(await original.arrayBuffer()),
    await readFile(path.join(ROOT, 'fixtures/uploads/panduan-demo.pdf')),
  );
  const md = await api(IDS.contributor, `/api/files/${r.versionId}/markdown`, undefined, 'GET');
  const text = await md.text();
  assert(text.includes('99.90%'));
  assert(text.includes('1. Verifikasi'));
  assert(text.includes('A2: VPN demo'));
  for (const slot of [1, 2, 3]) {
    assert.equal(
      (
        await api(
          IDS.contributor,
          `/api/files/${r.versionId}/attachments/${slot}`,
          undefined,
          'GET',
        )
      ).status,
      200,
    );
    assert.equal(
      (await api(IDS.viewer, `/api/files/${r.versionId}/attachments/${slot}`, undefined, 'GET'))
        .status,
      404,
    );
  }
});
test('sensitive draft needs explicit reviewer grants and two stages; revoke removes files/search/favorites', async () => {
  const r = await upload({
    classification: 'restricted',
    text: `# Sensitive synthetic\n${marker}-RESTRICTED`,
  });
  assert.equal(
    (await api(IDS.super, `/api/files/${r.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
  assert.equal(
    (
      await api(IDS.contributor, `/api/versions/${r.versionId}/submit`, {
        reviewers: [IDS.reviewer, IDS.admin],
        confirmed: true,
      })
    ).status,
    422,
  );
  for (const member of [IDS.reviewer, IDS.admin])
    assert.equal(
      (await api(IDS.contributor, `/api/documents/${r.documentId}/access`, { member, grant: true }))
        .status,
      200,
    );
  assert.equal(
    (
      await api(IDS.contributor, `/api/documents/${r.documentId}/access`, {
        member: IDS.viewer,
        grant: true,
      })
    ).status,
    404,
  );
  await submitted(r.versionId, [IDS.reviewer, IDS.admin]);
  assert.equal((await decision(IDS.reviewer, r.versionId)).status, 200);
  assert.equal((await decision(IDS.admin, r.versionId)).status, 200);
  await waitPublished(r.versionId);
  assert.equal(
    (await api(IDS.reviewer, `/api/files/${r.versionId}/markdown`, undefined, 'GET')).status,
    200,
  );
  assert.equal(
    (
      await api(IDS.contributor, `/api/documents/${r.documentId}/access`, {
        member: IDS.reviewer,
        grant: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await api(IDS.reviewer, `/api/files/${r.versionId}/markdown`, undefined, 'GET')).status,
    404,
  );
});
test('withdraw and expiry remove discovery and downloads despite retained indexes', async () => {
  const id = published.documentId,
    vid = published.versionId;
  await db.query(
    "UPDATE app.document_versions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [vid],
  );
  assert.equal((await api(IDS.viewer, `/api/files/${vid}/markdown`, undefined, 'GET')).status, 404);
  const search = await api(
    IDS.viewer,
    `/api/search?q=${encodeURIComponent(marker + '-FINAL')}`,
    undefined,
    'GET',
  );
  assert(!(await search.text()).includes(id));
  assert.equal(
    (
      await api(IDS.contributor, `/api/documents/${id}/withdraw`, {
        reason: 'Dokumen uji tidak berlaku lagi.',
      })
    ).status,
    200,
  );
  assert.equal((await api(IDS.viewer, `/api/files/${vid}/markdown`, undefined, 'GET')).status, 404);
});
