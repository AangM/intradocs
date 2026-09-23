import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { ROOT, localAdminUrl, isMain, reportFailure } from './shared.ts';
import { createBlobStore } from '../packages/core/src/storage.ts';
import { readRuntimeConfig } from '../packages/core/src/config.ts';
import { users, categories, documents, IDS, docId, versionId } from '../fixtures/data.ts';
export type DemoAccount = {
  id: string;
  name: string;
  email: string;
  role: string;
  password: string;
};
export async function seed(): Promise<void> {
  const pool = new Pool({ connectionString: localAdminUrl(), max: 1 });
  const c = await pool.connect();
  const credentialFile = path.join(ROOT, 'var/demo-accounts.json');
  try {
    await c.query('SELECT pg_advisory_lock(719281,3)');
    let accounts: DemoAccount[];
    if (existsSync(credentialFile))
      accounts = JSON.parse(await readFile(credentialFile, 'utf8')) as DemoAccount[];
    else {
      const count = await c.query<{ total: string }>(
        'SELECT count(*) AS total FROM auth."user" WHERE id=ANY($1::text[])',
        [users.map((u) => u.id)],
      );
      if (Number(count.rows[0]?.total) > 0)
        throw new Error(
          'Akun seed sudah ada tetapi var/demo-accounts.json hilang. Restore file credential; jangan menimpa password diam-diam.',
        );
      accounts = users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        password: randomBytes(18).toString('base64url'),
      }));
      await mkdir(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
      await writeFile(credentialFile, JSON.stringify(accounts, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
    if (
      accounts.length !== users.length ||
      users.some(
        (u) =>
          !accounts.find((a) => a.id === u.id && a.email === u.email && a.password.length >= 12),
      )
    )
      throw new Error('File akun lokal tidak lengkap.');
    const store = createBlobStore(readRuntimeConfig(process.env).storage, ROOT);
    await c.query('BEGIN');
    try {
      for (const u of users) {
        const a = accounts.find((a) => a.id === u.id)!;
        await c.query(
          'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT(id) DO NOTHING',
          [u.id, u.name, u.email],
        );
        const existing = await c.query(
          'SELECT 1 FROM auth.account WHERE "providerId"=\'credential\' AND "accountId"=$1',
          [u.id],
        );
        if (!existing.rowCount)
          await c.query(
            'INSERT INTO auth.account(id,"accountId","providerId","userId",issuer,password) VALUES($1,$2,\'credential\',$2,\'local:credential\',$3)',
            [randomUUID(), u.id, await hashPassword(a.password)],
          );
        else
          await c.query(
            "UPDATE auth.account SET issuer='local:credential' WHERE \"providerId\"='credential' AND \"accountId\"=$1 AND issuer IS DISTINCT FROM 'local:credential'",
            [u.id],
          );
        await c.query(
          'INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          [u.id, u.name, u.email, u.unit, u.role, u.active, u.scopeAll],
        );
      }
      for (const [position, cat] of categories.entries())
        await c.query(
          'INSERT INTO app.categories(id,name,description,icon,color,position,minimum_classification) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          [
            cat.id,
            cat.name,
            cat.description,
            cat.icon,
            cat.color,
            position,
            cat.id === '10000000-0000-4000-8000-000000000002' ? 'restricted' : 'internal',
          ],
        );
      for (const u of users)
        for (const cat of u.categories)
          await c.query(
            'INSERT INTO app.category_grants(user_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [u.id, cat],
          );
      for (const d of documents) {
        const owner = users.find((u) => u.id === d.owner)!;
        const id = docId(d.n),
          vid = versionId(d.n);
        const content = `# ${d.title}\n\n${d.markdown}\n`;
        const key = `documents/${id}/versions/${vid}/content.md`;
        const file = await store.putImmutable(key, Buffer.from(content));
        await store.putImmutable(
          `documents/${id}/versions/${vid}/provenance.json`,
          Buffer.from(
            JSON.stringify(
              {
                synthetic: true,
                source: 'seed-markdown',
                documentId: id,
                versionId: vid,
                sha256: file.sha256,
              },
              null,
              2,
            ),
          ),
        );
        const published = d.state === 'approved';
        const approver = d.owner === IDS.admin ? IDS.super : IDS.admin;
        await c.query(
          'INSERT INTO app.documents(id,slug,title,summary,category_id,owner_id,owner_label,classification,labels,current_version_id,withdrawn) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING',
          [
            id,
            d.slug,
            d.title,
            d.summary,
            d.category,
            d.owner,
            owner.name,
            d.classification,
            [...d.labels],
            published ? vid : null,
            'withdrawn' in d && d.withdrawn,
          ],
        );
        await c.query(
          `INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,byte_size,approved_by,approved_by_label,approved_at,review_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
          [
            vid,
            id,
            d.version,
            d.state,
            key,
            file.sha256,
            file.size,
            published ? approver : null,
            published ? users.find((u) => u.id === approver)!.name : null,
            published ? '2026-08-10T02:00:00Z' : null,
            published ? '2027-02-10T02:00:00Z' : null,
            'expired' in d ? '2020-01-01T00:00:00Z' : null,
          ],
        );
      }
      // Migration 006 derives the label vocabulary from documents that exist at migration
      // time. On a fresh checkout migrations run before this seed, so redo that backfill
      // here or app.labels stays empty (auto-tag pool, label suggestions, taxonomy page).
      await c.query(
        `INSERT INTO app.labels(category_id,name)
         SELECT DISTINCT d.category_id,label FROM app.documents d CROSS JOIN LATERAL unnest(d.labels) label
         WHERE length(trim(label)) BETWEEN 3 AND 32 ON CONFLICT DO NOTHING`,
      );
      for (const n of [6, 7])
        for (const userId of [IDS.reviewer, IDS.admin])
          await c.query(
            'INSERT INTO app.document_grants(document_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [docId(n), userId],
          );
      await c.query(
        'INSERT INTO app.review_assignments(document_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [docId(8), IDS.super],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
    console.log(
      'Seed sintetis siap: 7 akun, 6 kategori, 10 dokumen. Credential hanya di var/demo-accounts.json.',
    );
  } finally {
    await c.query('SELECT pg_advisory_unlock(719281,3)').catch(() => {});
    c.release();
    await pool.end();
  }
}
if (isMain(import.meta.url)) seed().catch(reportFailure);
