import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, reportFailure } from './shared.ts';
async function doctor() {
  console.log(`Node ${process.version}; root repository ditemukan.`);
  const docker = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  console.log(`Docker Compose: ${docker.status === 0 ? 'tersedia' : 'tidak tersedia'}`);
  loadLocalEnv();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    const r = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
    );
    const v = r.rows[0];
    if (!v || v.rolsuper || v.rolbypassrls || v.current_user !== 'intradocs_app')
      throw new Error('Role DB aplikasi tidak aman.');
    console.log('DB app terhubung; bukan superuser/BYPASSRLS.');
  } finally {
    await pool.end();
  }
  console.log(
    `Credential lokal: ${existsSync(path.join(ROOT, 'var/demo-accounts.json')) ? 'tersedia (tidak dicetak)' : 'belum dibuat'}`,
  );
  console.log(
    'Profil: local-dev M2a. AI off. Upload MD/TXT membutuhkan ClamAV; periksa dengan pnpm scanner:check. SSO/RAG belum aktif.',
  );
}
doctor().catch(reportFailure);
