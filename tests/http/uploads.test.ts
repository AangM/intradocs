// Requires pnpm dev, migration 003, seeded local accounts, and a REAL up-to-date ClamAV.
// No scanner mock, provider bypass, automatic skip, or mutation of existing user documents.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { localAdminUrl, ROOT } from '../../scripts/shared.ts';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../../packages/core/src/uploads.ts';
const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const ids = [randomUUID(), randomUUID(), randomUUID()];
let cookies: string[] = [];
const ownedDocs: string[] = [];
const category = '10000000-0000-4000-8000-000000000001',
  title = 'HTTP M2a synthetic ' + randomUUID().slice(0, 8),
  bytes = Buffer.from('# HTTP demo\r\nPRIVATE-HTTP-UPLOAD-CANARY\n');
let result: { documentId: string; versionId: string; slug: string };
const key = randomUUID();
function form() {
  const f = new FormData();
  f.set('file', new Blob([bytes], { type: 'text/markdown' }), 'http-demo.md');
  f.set('title', title);
  f.set('summary', 'Synthetic HTTP integration');
  f.set('categoryId', category);
  f.set('classification', 'internal');
  f.set('labels', '["Synthetic"]');
  f.set('synthetic', 'true');
  return f;
}
function upload(cookie: string, nonce = key, origin = base, payload = form()) {
  return fetch(base + '/api/documents/drafts', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Idempotency-Key': nonce },
    body: payload,
  });
}
before(async () => {
  await admin.query('DELETE FROM auth."rateLimit"');
  for (const [i, id] of ids.entries()) {
    const password = randomBytes(20).toString('base64url'),
      email = `http-m2a-${id}@example.test`;
    await admin.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
      [id, `HTTP M2a ${i}`, email],
    );
    await admin.query(
      'INSERT INTO auth.account(id,"accountId","providerId","userId",issuer,password) VALUES($1,$2,\'credential\',$2,\'local:credential\',$3)',
      [randomUUID(), id, await hashPassword(password)],
    );
    await admin.query(
      "INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES($1,$2,$3,'Synthetic HTTP',$4,true,false)",
      [id, `HTTP M2a ${i}`, email, i === 2 ? 'viewer' : 'contributor'],
    );
    await admin.query('INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2)', [
      id,
      category,
    ]);
    const response = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200, 'Temporary account must authenticate');
    cookies.push(
      response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    );
  }
  const readiness = await fetch(base + '/api/uploads/scanner', {
    headers: { Cookie: cookies[0]! },
  });
  assert.equal(readiness.status, 200);
  assert.equal(
    (await readiness.json()).ready,
    true,
    'Run pnpm knowledge:start and pnpm scanner:check first. No bypass exists.',
  );
});
after(async () => {
  try {
    const docs = (
      await admin.query<{ id: string }>(
        'SELECT id FROM app.documents WHERE owner_id=ANY($1::text[])',
        [ids],
      )
    ).rows.map((r) => r.id);
    ownedDocs.push(...docs);
    // Include failed-attempt orphan directories belonging only to these temporary accounts.
    const orphan = (
      await admin.query<{ document_id: string }>(
        'SELECT document_id FROM app.upload_requests WHERE owner_id=ANY($1::text[])',
        [ids],
      )
    ).rows.map((r) => r.document_id);
    ownedDocs.push(...orphan);
    await admin.query(
      'DELETE FROM app.audit_events WHERE actor_id=ANY($1::text[]) OR document_id=ANY($2::uuid[])',
      [ids, docs],
    );
    await admin.query(
      'DELETE FROM app.version_sources WHERE version_id IN (SELECT id FROM app.document_versions WHERE document_id=ANY($1::uuid[]))',
      [docs],
    );
    await admin.query('DELETE FROM app.document_versions WHERE document_id=ANY($1::uuid[])', [
      docs,
    ]);
    await admin.query('DELETE FROM app.documents WHERE id=ANY($1::uuid[])', [docs]);
    await admin.query('DELETE FROM app.upload_requests WHERE owner_id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM app.category_grants WHERE user_id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM app.profiles WHERE id=ANY($1::text[])', [ids]);
    await admin.query('DELETE FROM auth."user" WHERE id=ANY($1::text[])', [ids]);
    for (const id of new Set(ownedDocs))
      await rm(path.resolve(ROOT, process.env.STORAGE_ROOT ?? 'var/storage', 'documents', id), {
        recursive: true,
        force: true,
      });
  } finally {
    await admin.end();
    cookies = [];
  }
});
test('anonymous, Viewer, external origin, extra owner metadata fail before processing', async () => {
  assert.equal((await upload('')).status, 401);
  assert.equal((await upload(cookies[2]!)).status, 403);
  assert.equal((await upload(cookies[0]!, randomUUID(), 'https://evil.example')).status, 400);
  const injected = form();
  injected.set('ownerId', ids[1]!);
  assert.equal((await upload(cookies[0]!, randomUUID(), base, injected)).status, 400);
});
test('real authenticated upload returns an unpublished private draft with no-store response', async () => {
  const response = await upload(cookies[0]!);
  assert.equal(response.status, 201, await response.clone().text());
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  result = await response.json();
  assert(result.documentId && result.versionId);
  const row = (
    await admin.query('SELECT current_version_id,owner_id FROM app.documents WHERE id=$1', [
      result.documentId,
    ])
  ).rows[0];
  assert.equal(row.current_version_id, null);
  assert.equal(row.owner_id, ids[0]);
});
test('owner can verify exact original, normalized Markdown and provenance', async () => {
  assert(result, 'Previous upload must succeed');
  const original = await fetch(base + `/api/files/${result.versionId}/original`, {
    headers: { Cookie: cookies[0]! },
  });
  assert.equal(original.status, 200);
  assert.match(original.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(digest(new Uint8Array(await original.arrayBuffer())), digest(bytes));
  const markdown = await fetch(base + `/api/files/${result.versionId}/markdown`, {
    headers: { Cookie: cookies[0]! },
  });
  assert.equal(markdown.status, 200);
  assert.equal(await markdown.text(), bytes.toString().replace(/\r\n/g, '\n'));
  const proof = await fetch(base + `/api/files/${result.versionId}/provenance`, {
    headers: { Cookie: cookies[0]! },
  });
  assert.equal(proof.status, 200);
  const data = await proof.json();
  assert.equal(data.source.sha256, digest(bytes));
  assert.equal(data.scan.verdict, 'clean');
  assert.equal(data.metadata.classification, 'internal');
});
test('peer and Viewer cannot fetch any representation, source hash or Published search result', async () => {
  assert(result);
  for (const cookie of cookies.slice(1)) {
    for (const kind of ['markdown', 'original', 'provenance'])
      assert.equal(
        (
          await fetch(base + `/api/files/${result.versionId}/${kind}`, {
            headers: { Cookie: cookie },
          })
        ).status,
        404,
      );
    const query = await fetch(base + '/api/documents?status=all&q=' + encodeURIComponent(title), {
      headers: { Cookie: cookie },
    });
    assert(!(await query.text()).includes(result.documentId));
  }
  const published = await fetch(
    base + '/api/documents?status=published&q=' + encodeURIComponent(title),
    { headers: { Cookie: cookies[0]! } },
  );
  assert(!(await published.text()).includes(result.documentId));
});
test('retry and exact same-author duplicate do not add another document or upload audit', async () => {
  assert(result);
  const repeat = await upload(cookies[0]!);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).documentId, result.documentId);
  const duplicate = await upload(cookies[0]!, randomUUID());
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).documentId, result.documentId);
  assert.equal(
    (
      await admin.query(
        "SELECT id FROM app.audit_events WHERE action='document.uploaded' AND document_id=$1",
        [result.documentId],
      )
    ).rowCount,
    1,
  );
});
test('oversize, unsupported format, and invalid classification cannot create a draft', async () => {
  for (const [change, status] of [
    [
      (f: FormData) => f.set('file', new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]), 'huge.md'),
      413,
    ],
    [(f: FormData) => f.set('file', new Blob(['# x']), 'fake.pdf'), 415],
    [(f: FormData) => f.set('classification', 'PUBLIC'), 400],
  ] as const) {
    const f = form();
    change(f);
    assert.equal((await upload(cookies[0]!, randomUUID(), base, f)).status, status);
  }
});
