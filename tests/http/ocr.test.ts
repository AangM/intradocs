// OCR through the real pipeline: upload -> ClamAV -> converter (Tesseract) -> private draft.
// Needs the converter image built with tesseract (health reports ocr:true); otherwise the
// tests skip rather than fail, because the old behaviour (refuse scans) is still correct.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { localAdminUrl, ROOT } from '../../scripts/shared.ts';

const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
const base = process.env.APP_URL!;
const id = randomUUID();
const category = '10000000-0000-4000-8000-000000000001';
let cookie = '';
let ocr = false;

async function upload(file: string, title: string) {
  const f = new FormData();
  const bytes = await readFile(path.join(ROOT, 'fixtures/uploads', file));
  f.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), file);
  f.set('title', title);
  f.set('summary', 'Synthetic OCR integration');
  f.set('categoryId', category);
  f.set('classification', 'internal');
  f.set('labels', '["Synthetic"]');
  f.set('synthetic', 'true');
  return fetch(base + '/api/documents/drafts', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Idempotency-Key': randomUUID() },
    body: f,
  });
}

before(async () => {
  const port =
    (await readFile(path.join(ROOT, '.env.local'), 'utf8')).match(/^KNOWLEDGE_PORT=(\d+)/m)?.[1] ??
    '8091';
  const token =
    (await readFile(path.join(ROOT, '.env.local'), 'utf8')).match(/^KNOWLEDGE_TOKEN=(.+)$/m)?.[1] ??
    '';
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then((r) => r.json() as Promise<{ ocr?: boolean }>)
    .catch(() => ({ ocr: false }));
  ocr = health.ocr === true;
  if (!ocr) return;
  await admin.query('DELETE FROM auth."rateLimit"');
  const password = randomBytes(20).toString('base64url');
  const email = `http-ocr-${id}@example.test`;
  await admin.query(
    'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
    [id, 'HTTP OCR', email],
  );
  await admin.query(
    'INSERT INTO auth.account(id,"accountId","providerId","userId",issuer,password) VALUES($1,$2,\'credential\',$2,\'local:credential\',$3)',
    [randomUUID(), id, await hashPassword(password)],
  );
  await admin.query(
    "INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES($1,'HTTP OCR',$2,'Synthetic HTTP','contributor',true,false)",
    [id, email],
  );
  await admin.query('INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2)', [
    id,
    category,
  ]);
  const r = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200);
  cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
});
after(async () => {
  try {
    if (!ocr) return;
    const docs = [
      ...(
        await admin.query<{ id: string }>('SELECT id FROM app.documents WHERE owner_id=$1', [id])
      ).rows.map((r) => r.id),
      ...(
        await admin.query<{ document_id: string }>(
          'SELECT document_id FROM app.upload_requests WHERE owner_id=$1',
          [id],
        )
      ).rows.map((r) => r.document_id),
    ];
    await admin.query(
      'DELETE FROM app.audit_events WHERE actor_id=$1 OR document_id=ANY($2::uuid[])',
      [id, docs],
    );
    await admin.query(
      'DELETE FROM app.version_sources WHERE version_id IN (SELECT id FROM app.document_versions WHERE document_id=ANY($1::uuid[]))',
      [docs],
    );
    await admin.query('DELETE FROM app.document_versions WHERE document_id=ANY($1::uuid[])', [
      docs,
    ]);
    await admin.query('DELETE FROM app.documents WHERE id=ANY($1::uuid[])', [docs]);
    await admin.query('DELETE FROM app.upload_requests WHERE owner_id=$1', [id]);
    await admin.query('DELETE FROM app.category_grants WHERE user_id=$1', [id]);
    await admin.query('DELETE FROM app.profiles WHERE id=$1', [id]);
    await admin.query('DELETE FROM auth."user" WHERE id=$1', [id]);
    for (const d of new Set(docs))
      await rm(path.resolve(ROOT, process.env.STORAGE_ROOT ?? 'var/storage', 'documents', d), {
        recursive: true,
        force: true,
      });
  } finally {
    await admin.end();
  }
});

test(
  'a scanned PDF becomes a private draft whose Markdown is the OCR text, marked per page',
  { timeout: 200000 },
  async (t) => {
    if (!ocr) return t.skip('converter image without tesseract');
    const r = await upload(
      'scanned-ocr-demo.pdf',
      'HTTP OCR synthetic ' + randomUUID().slice(0, 8),
    );
    const body = await r.text();
    assert.equal(r.status, 201, body.slice(0, 200));
    const { versionId } = JSON.parse(body) as { versionId: string };
    const md = await (
      await fetch(`${base}/api/files/${versionId}/markdown`, { headers: { Cookie: cookie } })
    ).text();
    assert.match(md, /## Halaman 1 \(OCR\)/);
    assert.match(md, /Serah Terima/);
    assert.match(md, /5 hari kerja/);
    const proof = (await (
      await fetch(`${base}/api/files/${versionId}/provenance`, { headers: { Cookie: cookie } })
    ).json()) as { scan: { verdict: string }; conversion?: { warnings?: string[] } };
    assert.equal(proof.scan.verdict, 'clean', 'OCR never skips the virus scan');
  },
);

test(
  'a PDF with nothing readable is still refused, with the new wording',
  { timeout: 200000 },
  async (t) => {
    if (!ocr) return t.skip('converter image without tesseract');
    const r = await upload('scanned-empty-demo.pdf', 'HTTP OCR empty ' + randomUUID().slice(0, 8));
    assert.equal(r.status, 422);
    assert.match(await r.text(), /juga lewat OCR/);
  },
);
