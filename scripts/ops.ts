// Q6 operations for the local profile: backup and restore of everything IntraDocs owns,
// and a readiness probe with a named owner per dependency.
//
//   pnpm ops:backup [--out var/backups]     one folder per backup: db.dump (pg_dump custom
//                                           format), storage.tar (originals, canonical
//                                           Markdown, provenance), manifest.json (hashes,
//                                           counts, migrations); .env* is never included
//   pnpm ops:restore <folder> --yes         with the app stopped: restores database +
//                                           storage, re-verifies hashes and row counts,
//                                           re-runs migrate -- local database only,
//                                           refuses to run without --yes
//   pnpm ops:verify-backup <folder>         restore drill into a throw-away database and a
//                                           scratch folder: counts, migrations and every
//                                           storage hash must match; nothing live is touched
//   pnpm ops:ready                          the readiness table (DB, storage, scanner,
//                                           converter, WeKnora, Ollama) with the owner who
//                                           is paged for each; exit 1 when a required
//                                           dependency is down
//
// What a backup deliberately does NOT contain: WeKnora's own volumes. The knowledge base
// is derived from app.rag_index_entries and the canonical Markdown; after a restore
// `weknora:sync` rebuilds whatever is missing, and a restore from an older backup makes
// revoked or newer versions disappear from the index on the next sweep (§8 in
// docs/WEKNORA.md). Secrets (.env.local, var/demo-accounts.json) are not backed up: a
// restore onto another machine gets fresh ones from pnpm setup:local.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, PNPM, reportFailure } from './shared.ts';
import { readRuntimeConfig } from '../packages/core/src/config.ts';
import { converterOptions } from '../packages/core/src/converter.ts';

const COUNT_TABLES = [
  'app.documents',
  'app.document_versions',
  'app.version_sources',
  'app.version_attachments',
  'app.approval_requests',
  'app.rag_index_entries',
  'app.ai_conversations',
  'app.audit_events',
  'app.profiles',
];

function compose(args: string[], input?: string | Buffer, capture = false) {
  const r = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], {
    cwd: ROOT,
    env: process.env,
    input,
    stdio: capture
      ? ['pipe', 'pipe', 'inherit']
      : input === undefined
        ? 'inherit'
        : ['pipe', 'inherit', 'inherit'],
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`docker compose ${args.slice(0, 3).join(' ')} gagal (${r.status}).`);
  return r.stdout as Buffer | null;
}

/** A path relative to ROOT with forward slashes, the only form bsdtar on Windows accepts. */
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function counts(admin: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES)
    out[t] = Number((await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  return out;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else if (entry.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

async function backup(): Promise<void> {
  loadLocalEnv();
  const config = readRuntimeConfig(process.env);
  const outRoot = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]!
    : 'var/backups';
  if (!/^var\/[A-Za-z0-9_\-/]+$/.test(outRoot)) throw new Error('--out harus di bawah var/.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, outRoot, stamp);
  mkdirSync(dir, { recursive: true });
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  try {
    // 1. Database, custom format (compressed, restorable table by table), via the
    //    postgres container so no client tools are needed on the host.
    const dump = compose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'intradocs',
        '-Fc',
        '--no-owner',
      ],
      undefined,
      true,
    )!;
    await writeFile(path.join(dir, 'db.dump'), dump);
    // 2. Storage: a tar of the blob root, streamed through tar on the host (Windows ships
    //    bsdtar; Linux/macOS GNU tar) -- content hashes go in the manifest.
    const storageRoot = path.resolve(ROOT, config.storageRoot);
    const files = existsSync(storageRoot) ? walk(storageRoot) : [];
    const hashes: Record<string, string> = {};
    for (const f of files) hashes[f] = sha256(await readFile(path.join(storageRoot, f)));
    // Relative paths on purpose: bsdtar on Windows reads "C:\..." as a remote host.
    const tar = spawnSync(
      'tar',
      ['-cf', rel(path.join(dir, 'storage.tar')), '-C', config.storageRoot, '.'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (tar.status !== 0) throw new Error('tar gagal membuat storage.tar.');
    // 3. Manifest: what was backed up, from what schema, with what counts.
    const migrations = (
      await admin.query<{ name: string; sha256: string }>(
        'SELECT name, sha256 FROM infra.migrations ORDER BY name',
      )
    ).rows;
    const manifest = {
      createdAt: new Date().toISOString(),
      profile: process.env.APP_PROFILE,
      release: JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version,
      database: { file: 'db.dump', sha256: sha256(dump), bytes: dump.length },
      storage: { file: 'storage.tar', root: config.storageRoot, files: files.length, hashes },
      counts: await counts(admin),
      migrations,
      excluded: [
        '.env.local',
        'var/demo-accounts.json',
        'WeKnora volumes (derived; weknora:sync rebuilds)',
      ],
    };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      `Backup selesai: ${path.relative(ROOT, dir)}\n  db.dump ${dump.length} byte · storage ${files.length} berkas · ${migrations.length} migrasi · ${Object.entries(
        manifest.counts,
      )
        .map(([t, n]) => `${t.replace('app.', '')}=${n}`)
        .join(' ')}`,
    );
  } finally {
    await admin.end();
  }
}

async function restore(): Promise<void> {
  loadLocalEnv();
  const folder = process.argv[3];
  if (!folder || !process.argv.includes('--yes'))
    throw new Error(
      'Gunakan: pnpm ops:restore <folder-backup> --yes  (menimpa database dan storage lokal)',
    );
  if (process.env.APP_PROFILE !== 'local-dev')
    throw new Error('Restore lewat skrip ini hanya untuk profil local-dev.');
  const dir = path.resolve(ROOT, folder);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    database: { sha256: string };
    storage: { root: string; hashes: Record<string, string>; files: number };
    counts: Record<string, number>;
    migrations: Array<{ name: string }>;
  };
  const dump = await readFile(path.join(dir, 'db.dump'));
  if (sha256(dump) !== manifest.database.sha256)
    throw new Error('db.dump tidak cocok dengan manifest.');
  const config = readRuntimeConfig(process.env);
  if (config.storageRoot !== manifest.storage.root)
    throw new Error(
      `Backup dibuat untuk STORAGE_ROOT=${manifest.storage.root}, bukan ${config.storageRoot}.`,
    );
  // 1. The app and worker must be down: a live server would keep writing into schemas
  //    that are about to be dropped, and hold connections that block the drop.
  const alive = await fetch(`${process.env.APP_URL}/api/health`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  if (alive)
    throw new Error(
      'Hentikan pnpm dev / pnpm start dulu; restore menimpa database yang sedang dipakai.',
    );
  // 2. Database: drop and recreate the application schemas, then pg_restore. Roles are
  //    global and are kept (the dump was taken with --no-owner).
  compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'intradocs',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    'DROP SCHEMA IF EXISTS app, auth, infra, jobs CASCADE;',
  );
  compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      'intradocs',
      '--no-owner',
      '--exit-on-error',
    ],
    dump,
  );
  // 3. Storage: wipe the root and unpack the tar, then verify every hash.
  const storageRoot = path.resolve(ROOT, config.storageRoot);
  mkdirSync(storageRoot, { recursive: true });
  rmSync(storageRoot, { recursive: true, force: true });
  mkdirSync(storageRoot, { recursive: true });
  const tar = spawnSync(
    'tar',
    ['-xf', rel(path.join(dir, 'storage.tar')), '-C', config.storageRoot],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (tar.status !== 0) throw new Error('tar gagal mengekstrak storage.tar.');
  let bad = 0;
  for (const [f, h] of Object.entries(manifest.storage.hashes))
    if (
      !existsSync(path.join(storageRoot, f)) ||
      sha256(await readFile(path.join(storageRoot, f))) !== h
    )
      bad++;
  if (bad) throw new Error(`${bad} berkas storage tidak cocok dengan manifest setelah restore.`);
  // 4. Migrations newer than the backup, then counts, then the WeKnora index.
  const migrate = spawnSync(PNPM, ['db:migrate'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (migrate.status !== 0) throw new Error('db:migrate gagal setelah restore.');
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  try {
    const now = await counts(admin);
    const diff = Object.entries(manifest.counts).filter(([t, n]) => now[t] !== n);
    if (diff.length)
      throw new Error(
        `Jumlah baris berbeda dari manifest: ${diff.map(([t, n]) => `${t} ${now[t]}≠${n}`).join(', ')}`,
      );
  } finally {
    await admin.end();
  }
  console.log(
    `Restore selesai dari ${path.relative(ROOT, dir)}: ${manifest.storage.files} berkas storage terverifikasi, ${Object.keys(manifest.counts).length} tabel cocok.\nJalankan: pnpm weknora:sync (bila profil weknora aktif) lalu pnpm dev / pnpm start.`,
  );
}

/**
 * The restore drill that touches nothing live: the dump is restored into a throw-away
 * database in the same container, row counts are compared with the manifest, the tar is
 * unpacked into a scratch folder and every hash is checked, then both are removed. This
 * is what proves a backup is restorable without wiping the working copy.
 */
async function verify(): Promise<void> {
  loadLocalEnv();
  const folder = process.argv[3];
  if (!folder) throw new Error('Gunakan: pnpm ops:verify-backup <folder-backup>');
  const dir = path.resolve(ROOT, folder);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    database: { sha256: string };
    storage: { hashes: Record<string, string>; files: number };
    counts: Record<string, number>;
    migrations: Array<{ name: string }>;
  };
  const dump = await readFile(path.join(dir, 'db.dump'));
  if (sha256(dump) !== manifest.database.sha256)
    throw new Error('db.dump tidak cocok dengan manifest.');
  const scratchDb = `intradocs_verify_${Date.now()}`;
  compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    `CREATE DATABASE ${scratchDb};`,
  );
  const scratchDir = path.join(ROOT, 'var', `verify-${Date.now()}`);
  try {
    compose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        scratchDb,
        '--no-owner',
        '--exit-on-error',
      ],
      dump,
    );
    const rows = compose(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        scratchDb,
        '-Atc',
        COUNT_TABLES.map((t) => `SELECT '${t}'||':'||count(*) FROM ${t}`).join(' UNION ALL '),
      ],
      undefined,
      true,
    )!
      .toString('utf8')
      .trim()
      .split(/\r?\n/);
    const restored = Object.fromEntries(
      rows.map((r) => [r.split(':')[0]!, Number(r.split(':')[1])]),
    );
    const diff = Object.entries(manifest.counts).filter(([t, n]) => restored[t] !== n);
    if (diff.length)
      throw new Error(
        `Jumlah baris di database uji berbeda: ${diff.map(([t, n]) => `${t} ${restored[t]}≠${n}`).join(', ')}`,
      );
    const migrated = compose(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        scratchDb,
        '-Atc',
        'SELECT count(*) FROM infra.migrations',
      ],
      undefined,
      true,
    )!
      .toString('utf8')
      .trim();
    if (Number(migrated) !== manifest.migrations.length)
      throw new Error(
        `Migrasi di database uji ${migrated} ≠ manifest ${manifest.migrations.length}.`,
      );
    mkdirSync(scratchDir, { recursive: true });
    const tar = spawnSync(
      'tar',
      ['-xf', rel(path.join(dir, 'storage.tar')), '-C', rel(scratchDir)],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (tar.status !== 0) throw new Error('tar gagal mengekstrak storage.tar.');
    let bad = 0;
    for (const [f, h] of Object.entries(manifest.storage.hashes))
      if (
        !existsSync(path.join(scratchDir, f)) ||
        sha256(await readFile(path.join(scratchDir, f))) !== h
      )
        bad++;
    if (bad) throw new Error(`${bad} berkas storage tidak cocok dengan manifest.`);
    console.log(
      `Backup ${path.relative(ROOT, dir)} terverifikasi: ${Object.keys(manifest.counts).length} tabel cocok, ${manifest.migrations.length} migrasi, ${manifest.storage.files} berkas storage cocok hash. Database uji dan folder sementara dihapus.`,
    );
  } finally {
    compose(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      `DROP DATABASE IF EXISTS ${scratchDb};`,
    );
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

async function ready(): Promise<void> {
  loadLocalEnv();
  const base = process.env.APP_URL!;
  const rows: Array<{ dep: string; required: boolean; owner: string; ok: boolean; note: string }> =
    [];
  const probe = async (
    dep: string,
    required: boolean,
    owner: string,
    fn: () => Promise<string>,
  ) => {
    try {
      rows.push({ dep, required, owner, ok: true, note: await fn() });
    } catch (e) {
      rows.push({ dep, required, owner, ok: false, note: (e as Error).message.slice(0, 80) });
    }
  };
  await probe('PostgreSQL', true, 'Developer B (data)', async () => {
    const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
    try {
      const r = await admin.query('SELECT count(*)::int AS n FROM infra.migrations');
      return `${r.rows[0].n} migrasi`;
    } finally {
      await admin.end();
    }
  });
  await probe('Web /api/health', true, 'Developer A (web)', async () => {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { release?: string; ai?: string };
    return `release ${j.release} · ai ${j.ai}`;
  });
  await probe('Storage root', true, 'Developer B (data)', async () => {
    const root = path.resolve(ROOT, readRuntimeConfig(process.env).storageRoot);
    if (!existsSync(root)) throw new Error('belum ada');
    return `${walk(root).length} berkas`;
  });
  await probe('ClamAV (unggah)', false, 'Developer B (ingest)', async () => {
    const r = await fetch(`${base}/api/uploads/scanner`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 401) return 'endpoint hidup (butuh sesi untuk detail)';
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return 'siap';
  });
  await probe('Converter', false, 'Developer B (ingest)', async () => {
    const c = converterOptions(process.env);
    const r = await fetch(c.url.replace('/convert', '/health'), {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(3000),
    });
    const body = (await r.json().catch(() => ({}))) as { pipeline?: string };
    if (!r.ok || body.pipeline !== 'canonical-v2') throw new Error(`HTTP ${r.status}`);
    return 'canonical-v2 siap';
  });
  await probe('WeKnora', false, 'Developer B (RAG)', async () => {
    const url = process.env.WEKNORA_BASE_URL;
    if (!url || process.env.AI_PROVIDER !== 'weknora-local') return 'AI off (tidak diperlukan)';
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return 'healthy';
  });
  await probe('Ollama', false, 'Developer B (RAG)', async () => {
    if (process.env.AI_PROVIDER !== 'weknora-local') return 'AI off (tidak diperlukan)';
    const r = await fetch('http://127.0.0.1:11434/api/version', {
      signal: AbortSignal.timeout(3000),
    });
    const j = (await r.json()) as { version?: string };
    return `v${j.version}`;
  });
  const width = Math.max(...rows.map((r) => r.dep.length));
  for (const r of rows)
    console.log(
      `${r.ok ? 'OK  ' : r.required ? 'DOWN' : 'off '} ${r.dep.padEnd(width)}  ${r.note.padEnd(42)}  ${r.required ? 'wajib' : 'opsional'} · ${r.owner}`,
    );
  if (rows.some((r) => r.required && !r.ok)) process.exitCode = 1;
}

const action = process.argv[2];
const run =
  action === 'backup'
    ? backup
    : action === 'restore'
      ? restore
      : action === 'verify-backup'
        ? verify
        : action === 'ready'
          ? ready
          : null;
if (!run) {
  console.error(
    'Gunakan: pnpm ops:backup | pnpm ops:verify-backup <folder> | pnpm ops:restore <folder> --yes | pnpm ops:ready',
  );
  process.exit(2);
}
run().catch(reportFailure);
