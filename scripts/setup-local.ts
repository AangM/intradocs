import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, command, loadLocalEnv, reportFailure } from './shared.ts';
import { migrate } from './migrate.ts';
import { seed } from './seed.ts';
async function setup() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Gunakan Node.js 24 LTS.');
  command('docker', ['compose', 'version'], { quiet: true });
  const envFile = path.join(ROOT, '.env.local');
  if (!existsSync(envFile)) {
    const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
    const admin = random(),
      app = random(),
      auth = random(),
      worker = random();
    // A second checkout on the same machine (e.g. a git worktree) must not share the
    // `intradocs-local` compose project: same volumes, same ports. Set
    // COMPOSE_PROJECT_NAME and POSTGRES_PORT in the shell for this first run and they
    // are pinned into .env.local, where Compose reads them on every later call.
    const postgresPort = process.env.POSTGRES_PORT ?? '54329';
    if (!/^\d{2,5}$/.test(postgresPort)) throw new Error('POSTGRES_PORT tidak valid.');
    const projectName = process.env.COMPOSE_PROJECT_NAME;
    const url = (user: string, password: string) =>
      `postgresql://${user}:${password}@127.0.0.1:${postgresPort}/intradocs`;
    const entries = {
      ...(projectName ? { COMPOSE_PROJECT_NAME: projectName } : {}),
      APP_PROFILE: 'local-dev',
      APP_URL: 'http://localhost:3000',
      AUTH_MODE: 'local',
      AI_PROVIDER: 'off',
      STORAGE_DRIVER: 'filesystem',
      STORAGE_ROOT: 'var/storage',
      POSTGRES_PORT: postgresPort,
      POSTGRES_PASSWORD: admin,
      DATABASE_ADMIN_URL: url('postgres', admin),
      DATABASE_URL: url('intradocs_app', app),
      AUTH_DATABASE_URL: url('intradocs_auth', auth),
      WORKER_DATABASE_URL: url('intradocs_worker', worker),
      BETTER_AUTH_SECRET: random(),
      NEXT_TELEMETRY_DISABLED: '1',
      // Compose v5 interpolates every service in the file, including the ones behind
      // the weknora profile, so their required secrets must exist before the first
      // `compose up postgres`. Same names and sizes as weknora:setup, which keeps
      // whatever is already here. SYSTEM_AES_KEY must be exactly 32 chars.
      WEKNORA_DB_PASSWORD: random(),
      WEKNORA_REDIS_PASSWORD: random(24),
      WEKNORA_JWT_SECRET: random(),
      WEKNORA_AES_KEY: random(24),
    };
    await writeFile(
      envFile,
      Object.entries(entries)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log('.env.local dibuat dengan credential acak; tidak dicetak ke log.');
  }
  loadLocalEnv();
  await mkdir(path.join(ROOT, 'var'), { recursive: true, mode: 0o700 });
  command('docker', ['compose', '--env-file', '.env.local', 'up', '-d', 'postgres']);
  const pool = new Pool({
    connectionString: process.env.DATABASE_ADMIN_URL,
    connectionTimeoutMillis: 2000,
  });
  let ready = false;
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await pool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  } finally {
    await pool.end();
  }
  if (!ready)
    throw new Error(
      'PostgreSQL belum siap. Periksa docker compose --env-file .env.local logs postgres.',
    );
  await migrate();
  await seed();
  console.log('Setup selesai. Akun lokal ada di var/demo-accounts.json. Jalankan pnpm dev.');
}
setup().catch(reportFailure);
