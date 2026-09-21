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
//   pnpm ops:preflight                      the release gate: every refusal that must
//                                           happen before a deployment serves anyone --
//                                           profile, TLS origin, secret strength, every
//                                           migration applied, no demo accounts, a backup
//                                           whose restore drill passed. Exit 1 on failure
//   pnpm ops:watch [--interval 30]          the alarm: polls health, prints one line per
//                                           state CHANGE, exits 1 once it has been down
//                                           --grace times in a row
//   pnpm ops:rollback-check <ref>           whether rolling the code back to a tag is safe
//                                           on its own, or needs a database restore with
//                                           it because migrations ran in between
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
import { S3BlobStore } from '../packages/core/src/s3.ts';
import { readRuntimeConfig } from '../packages/core/src/config.ts';
import { converterOptions } from '../packages/core/src/converter.ts';

/** A storage root must never sit under a served tree, whatever the profile. */
const WEBROOT = /(^|[\\/])public([\\/]|$)/;
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
    //    bsdtar; Linux/macOS GNU tar) -- content hashes go in the manifest. With an S3
    //    bucket the blobs are not on this machine: the bucket's own versioning and
    //    replication are the backup, and the manifest records which bucket that is so a
    //    restore can refuse a mismatch.
    const files: string[] = [];
    const hashes: Record<string, string> = {};
    if (config.storage.driver === 'filesystem') {
      const storageRoot = path.resolve(ROOT, config.storage.root);
      if (existsSync(storageRoot)) files.push(...walk(storageRoot));
      for (const f of files) hashes[f] = sha256(await readFile(path.join(storageRoot, f)));
      // Relative paths on purpose: bsdtar on Windows reads "C:\..." as a remote host.
      const tar = spawnSync(
        'tar',
        ['-cf', rel(path.join(dir, 'storage.tar')), '-C', config.storage.root, '.'],
        { cwd: ROOT, stdio: 'inherit' },
      );
      if (tar.status !== 0) throw new Error('tar gagal membuat storage.tar.');
    } else
      console.log(
        `Storage S3 (${config.storage.bucket}) tidak ikut: versioning bucket adalah backupnya.`,
      );
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
      storage:
        config.storage.driver === 'filesystem'
          ? { file: 'storage.tar', root: config.storage.root, files: files.length, hashes }
          : {
              file: null,
              root: `s3://${config.storage.bucket}/${config.storage.prefix}`,
              files: 0,
              hashes,
            },
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
    storage: { file: string | null; root: string; hashes: Record<string, string>; files: number };
    counts: Record<string, number>;
    migrations: Array<{ name: string }>;
  };
  const dump = await readFile(path.join(dir, 'db.dump'));
  if (sha256(dump) !== manifest.database.sha256)
    throw new Error('db.dump tidak cocok dengan manifest.');
  const config = readRuntimeConfig(process.env);
  const storageName =
    config.storage.driver === 'filesystem'
      ? config.storage.root
      : `s3://${config.storage.bucket}/${config.storage.prefix}`;
  if (storageName !== manifest.storage.root)
    throw new Error(`Backup dibuat untuk storage ${manifest.storage.root}, bukan ${storageName}.`);
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
  // 3. Storage: wipe the root and unpack the tar, then verify every hash. An S3 bucket
  //    is not touched: the database now points at keys the bucket still holds (keys are
  //    immutable and never reused), and rolling the bucket back is its own operation.
  if (config.storage.driver === 'filesystem' && manifest.storage.file) {
    const storageRoot = path.resolve(ROOT, config.storage.root);
    mkdirSync(storageRoot, { recursive: true });
    rmSync(storageRoot, { recursive: true, force: true });
    mkdirSync(storageRoot, { recursive: true });
    const tar = spawnSync(
      'tar',
      ['-xf', rel(path.join(dir, manifest.storage.file)), '-C', config.storage.root],
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
  } else console.log('Storage S3 tidak disentuh oleh restore; kunci bersifat immutable.');
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
    // Record that the drill passed, in the backup itself: `ops:preflight` refuses a
    // release whose newest backup has never been restored, and this stamp is the proof.
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, verifiedAt: new Date().toISOString() }, null, 2) + '\n',
    );
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
  await probe('Storage', true, 'Developer B (data)', async () => {
    const storage = readRuntimeConfig(process.env).storage;
    if (storage.driver === 's3') {
      await new S3BlobStore(storage, { timeoutMs: 5000 }).probe();
      return `bucket ${storage.bucket} menjawab`;
    }
    const root = path.resolve(ROOT, storage.root);
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

/**
 * The release gate. Everything here is a refusal that must happen before a deployment
 * takes its first request, and each check says what to do rather than only that it
 * failed. On a local-dev profile the deployment-only checks are reported but not fatal:
 * the point is that the same command, run against a real environment, is the thing that
 * says "this may go live".
 */
async function preflight(): Promise<void> {
  loadLocalEnv();
  const checks: Array<{ name: string; ok: boolean; note: string; fatal: boolean }> = [];
  const add = (name: string, ok: boolean, note: string, fatal = true) =>
    checks.push({ name, ok, note, fatal });
  let config: ReturnType<typeof readRuntimeConfig> | null = null;
  try {
    config = readRuntimeConfig(process.env);
    add('Konfigurasi', true, `profil ${config.profile}${config.hardened ? ' (hardened)' : ''}`);
  } catch (e) {
    add('Konfigurasi', false, (e as Error).message);
  }
  const hardened = config?.hardened ?? false;
  if (config) {
    add('Origin', !hardened || config.appUrl.startsWith('https://'), config.appUrl);
    add(
      'Secret',
      config.authSecret.length >= (hardened ? 48 : 32),
      `${config.authSecret.length} karakter`,
    );
    if (config.storage.driver === 'filesystem')
      add('Storage di luar webroot', !WEBROOT.test(config.storage.root), config.storage.root);
    else {
      // The bucket answers with these credentials, or the release does not go out.
      let ok = true;
      let note = `s3://${config.storage.bucket} via ${config.storage.endpoint}`;
      try {
        await new S3BlobStore(config.storage, { timeoutMs: 5000 }).probe();
      } catch (e) {
        ok = false;
        note += ` — ${e instanceof Error ? e.message : 'tidak menjawab'}`;
      }
      add('Bucket S3 menjawab', ok, note);
      add(
        'Endpoint S3 https',
        config.storage.endpoint.startsWith('https://'),
        config.storage.endpoint,
      );
    }
  }
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  try {
    const applied = await admin.query<{ name: string }>('SELECT name FROM infra.migrations');
    const onDisk = readdirSync(path.join(ROOT, 'packages/db/migrations')).filter((f) =>
      f.endsWith('.sql'),
    );
    const missing = onDisk.filter((f) => !applied.rows.some((r) => r.name === f));
    add(
      'Migrasi',
      missing.length === 0,
      missing.length ? `belum diterapkan: ${missing.join(', ')}` : `${applied.rowCount} diterapkan`,
    );
    // Demo identities are fine locally and unacceptable anywhere else: their passwords
    // are generated into a file this repository documents.
    const demo = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.profiles WHERE email LIKE '%@example.test'",
    );
    add(
      'Akun demo',
      !hardened || demo.rows[0]!.n === 0,
      hardened
        ? `${demo.rows[0]!.n} akun @example.test (harus 0)`
        : `${demo.rows[0]!.n} akun demo (wajar pada local-dev)`,
      hardened,
    );
    const synthetic = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.document_versions v JOIN app.documents d ON d.current_version_id=v.id WHERE v.title ILIKE '%sintetis%' OR v.title ILIKE '%contoh%'",
    );
    add(
      'Korpus sintetis',
      !hardened || synthetic.rows[0]!.n === 0,
      `${synthetic.rows[0]!.n} dokumen contoh`,
      false,
    );
    const owner = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.profiles WHERE role='super_admin' AND active",
    );
    add('Super admin aktif', owner.rows[0]!.n >= 1, `${owner.rows[0]!.n} akun`);
  } catch (e) {
    add('Database', false, (e as Error).message.slice(0, 90));
  } finally {
    await admin.end();
  }
  // A deployment whose backup nobody has restored does not have a backup yet.
  const backups = path.join(ROOT, 'var/backups');
  const folders = existsSync(backups)
    ? readdirSync(backups).filter((f) => existsSync(path.join(backups, f, 'manifest.json')))
    : [];
  let verified = '';
  for (const f of folders.sort().reverse()) {
    const manifest = JSON.parse(await readFile(path.join(backups, f, 'manifest.json'), 'utf8')) as {
      verifiedAt?: string;
    };
    if (manifest.verifiedAt) {
      verified = `${f} (drill ${manifest.verifiedAt})`;
      break;
    }
  }
  add(
    'Backup terverifikasi',
    Boolean(verified),
    verified || 'jalankan pnpm ops:backup lalu pnpm ops:verify-backup <folder>',
    hardened,
  );
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks)
    console.log(
      `${c.ok ? 'OK   ' : c.fatal ? 'GAGAL' : 'catat'} ${c.name.padEnd(width)}  ${c.note}`,
    );
  const failed = checks.filter((c) => !c.ok && c.fatal);
  if (failed.length) {
    console.error(`\n${failed.length} gate belum terpenuhi; rilis ditahan.`);
    process.exitCode = 1;
  } else console.log('\nSemua gate rilis terpenuhi.');
}

/**
 * The alarm. `ops:ready` answers "is it up now"; this answers "tell me when that
 * changes". One line per transition keeps a log quiet while things are healthy, and the
 * exit code is what a supervisor, a cron wrapper or a pager script reacts to.
 */
async function watch(): Promise<void> {
  const flag = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name);
    const value = i > 0 ? Number(process.argv[i + 1]) : NaN;
    return Number.isFinite(value) ? value : fallback;
  };
  const interval = Math.max(5, flag('--interval', 30)) * 1000;
  const grace = Math.max(1, flag('--grace', 3));
  loadLocalEnv();
  const base = process.env.APP_URL!;
  let lastOk: boolean | null = null;
  let failures = 0;
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (;;) {
    let note = '';
    let ok = false;
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await r.json().catch(() => ({}))) as { release?: string; ai?: string };
      ok = r.ok;
      note = ok ? `release ${body.release} · ai ${body.ai}` : `HTTP ${r.status}`;
    } catch (e) {
      note = (e as Error).message.slice(0, 70);
    }
    if (ok !== lastOk) {
      console.log(`${stamp()}  ${ok ? 'UP  ' : 'DOWN'}  ${note}`);
      lastOk = ok;
    }
    failures = ok ? 0 : failures + 1;
    if (failures >= grace) {
      console.error(`${stamp()}  ALARM  ${failures}x berturut-turut gagal: ${note}`);
      process.exitCode = 1;
      return;
    }
    if (process.argv.includes('--once')) return;
    await new Promise((done) => setTimeout(done, interval));
  }
}

/**
 * Is rolling the code back to `ref` safe on its own?
 *
 * Migrations are forward-only by design, so the dangerous rollback is the one that
 * crosses a migration boundary: the old code meets a newer schema. This compares the
 * migrations that exist in a git ref with the ones the database has applied and says
 * which of the two rollbacks this is -- code alone, or code plus a restore from the
 * backup taken before those migrations ran. It changes nothing; it answers a question
 * that is otherwise answered by guessing at 3am.
 *
 *   pnpm ops:rollback-check v0.2.0
 */
async function rollbackCheck(): Promise<void> {
  loadLocalEnv();
  const ref = process.argv[3];
  if (!ref) throw new Error('Sebutkan git ref-nya: pnpm ops:rollback-check <tag|commit>');
  const listed = spawnSync('git', ['ls-tree', '--name-only', `${ref}:packages/db/migrations`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (listed.status !== 0)
    throw new Error(`Tidak dapat membaca ${ref}: ${(listed.stderr || '').trim().slice(0, 120)}`);
  const inRef = new Set(
    listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.sql')),
  );
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  let applied: string[];
  try {
    const r = await admin.query<{ name: string }>(
      'SELECT name FROM infra.migrations ORDER BY name',
    );
    applied = r.rows.map((x) => x.name);
  } finally {
    await admin.end();
  }
  const ahead = applied.filter((name) => !inRef.has(name));
  console.log(`Ref ${ref}: ${inRef.size} migrasi · database: ${applied.length} diterapkan`);
  if (!ahead.length) {
    console.log(
      [
        '',
        'AMAN: rollback kode saja.',
        `  docker compose -f compose.prod.yaml --env-file .env.production up -d`,
        `  (dengan INTRADOCS_IMAGE=intradocs:${ref.replace(/^v/, '')})`,
        '',
        'Skema tidak berubah sejak ref itu, jadi kode lama bertemu skema yang sama.',
      ].join('\n'),
    );
    return;
  }
  console.log(
    [
      '',
      `HATI-HATI: database ${ahead.length} migrasi lebih maju daripada ${ref}:`,
      ...ahead.map((n) => `  ${n}`),
      '',
      'Kode lama akan bertemu skema yang lebih baru. Pilih salah satu:',
      '  1. Tetap di rilis sekarang dan perbaiki maju (paling sering benar).',
      '  2. Rollback kode DAN restore database dari backup sebelum migrasi itu:',
      '     pnpm ops:restore var/backups/<stamp-sebelum-migrasi> --yes',
      '     Semua perubahan setelah backup itu hilang; pastikan itu keputusan sadar.',
    ].join('\n'),
  );
  // Not an error: this is information for a decision, not a failed gate.
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
          : action === 'preflight'
            ? preflight
            : action === 'watch'
              ? watch
              : action === 'rollback-check'
                ? rollbackCheck
                : null;
if (!run) {
  console.error(
    'Gunakan: pnpm ops:backup | pnpm ops:verify-backup <folder> | pnpm ops:restore <folder> --yes | pnpm ops:ready | pnpm ops:preflight | pnpm ops:watch | pnpm ops:rollback-check <ref>',
  );
  process.exit(2);
}
run().catch(reportFailure);
