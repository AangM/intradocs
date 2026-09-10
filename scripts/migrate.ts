import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { ROOT, localAdminUrl, isMain, reportFailure } from './shared.ts';
import { assertLocalDatabase } from '../packages/core/src/config.ts';
export async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: localAdminUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(719281,2)');
    const roles = [
      ['intradocs_app', 'DATABASE_URL'],
      ['intradocs_auth', 'AUTH_DATABASE_URL'],
      ['intradocs_worker', 'WORKER_DATABASE_URL'],
    ] as const;
    for (const [role, envKey] of roles) {
      const u = assertLocalDatabase(process.env[envKey] ?? '');
      const app = new URL(process.env.DATABASE_URL!);
      if (u.host !== app.host || u.pathname !== app.pathname)
        throw new Error('Semua role harus memakai satu database lokal yang sama.');
      if (decodeURIComponent(u.username) !== role) throw new Error(`Role pada ${envKey} salah.`);
      const password = decodeURIComponent(u.password);
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(password))
        throw new Error('Password DB harus acak dan URL-safe.');
      const present = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
      // Identifiers are a closed constant list; password character set excludes SQL quoting.
      await client.query(
        `${present.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
      );
    }
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='intradocs_policy'")).rowCount)
      await client.query(
        'CREATE ROLE intradocs_policy NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS',
      );
    await client.query(
      'ALTER ROLE intradocs_policy NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS',
    );
    await client.query('CREATE SCHEMA IF NOT EXISTS infra');
    await client.query('REVOKE ALL ON SCHEMA infra FROM PUBLIC');
    await client.query(
      'CREATE TABLE IF NOT EXISTS infra.migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = path.join(ROOT, 'packages/db/migrations');
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const found = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM infra.migrations WHERE name=$1',
        [name],
      );
      if (found.rows[0]) {
        if (found.rows[0].sha256 !== hash)
          throw new Error(`Migrasi ${name} berubah setelah diterapkan; buat migrasi baru.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO infra.migrations(name,sha256) VALUES($1,$2)', [name, hash]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      console.log(`Migrasi diterapkan: ${name}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(719281,2)').catch(() => {});
    client.release();
    await pool.end();
  }
}
if (isMain(import.meta.url)) migrate().catch(reportFailure);
