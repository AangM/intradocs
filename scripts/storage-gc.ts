import { Pool } from 'pg';
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, localAdminUrl, reportFailure } from './shared.ts';
import { readRuntimeConfig } from '../packages/core/src/config.ts';
import { planOrphanCleanup, removeOrphanVersion } from '../packages/core/src/orphan-cleanup.ts';
import { readStorageReferences } from '../packages/db/src/maintenance.ts';
async function privateDirectory(relative: string, create = false): Promise<string> {
  const root = await realpath(ROOT);
  let current = root;
  for (const part of relative.split('/')) {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Folder privat tidak valid.');
    current = path.join(current, part);
    if (create) await mkdir(current, { recursive: true, mode: 0o700 });
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink() || !s.isDirectory())
        throw new Error('Folder privat tidak boleh berupa symlink/file.');
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return path.join(root, ...relative.split('/'));
}
async function main() {
  const flags = process.argv.slice(2);
  if (
    flags.some((f) => !['--check', '--apply'].includes(f)) ||
    new Set(flags).size !== flags.length ||
    (flags.includes('--apply') && flags.includes('--check'))
  )
    throw new Error('Gunakan pnpm storage:gc [--check atau --apply]. Default hanya memeriksa.');
  const apply = flags.includes('--apply');
  const pool = new Pool({
    connectionString: localAdminUrl(),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const config = readRuntimeConfig(process.env);
  const storage = await privateDirectory(config.storageRoot);
  const client = await pool.connect();
  const locks: Array<[number, number]> = [];
  let journal: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await client.query("SET statement_timeout='5s'");
    // Same session locks used by migration and seed; upload transactions use shared 719283/1.
    for (const key of (apply
      ? [
          [719281, 2],
          [719281, 3],
          [719283, 1],
        ]
      : []) as Array<[number, number]>) {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) AS acquired',
        key,
      );
      if (!result.rows[0]?.acquired)
        throw new Error(
          'Migration, seed, upload, atau cleanup lain sedang aktif. Coba lagi nanti.',
        );
      locks.push(key);
    }
    const plan = await planOrphanCleanup(storage, await readStorageReferences(client));
    const bytes = plan.eligible.reduce((n, c) => n + c.bytes, 0);
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'check',
          retentionHours: 24,
          scannedVersions: plan.scanned,
          eligibleVersions: plan.eligible.length,
          eligibleBytes: bytes,
          retained: plan.retained,
          truncated: plan.truncated,
        },
        null,
        2,
      ),
    );
    if (!apply) {
      console.log(
        'Tidak ada berkas dihapus. Tinjau hasil sebelum menjalankan pnpm storage:gc --apply.',
      );
      return;
    }
    if (plan.truncated)
      throw new Error(
        'Pemeriksaan mencapai batas; tidak ada penghapusan. Perlu pemeriksaan operator.',
      );
    if (!plan.eligible.length) {
      console.log('Tidak ada orphan lama yang memenuhi syarat.');
      return;
    }
    const batch = plan.eligible.slice(0, 100),
      logDir = await privateDirectory('var/maintenance', true),
      logName = `gc-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`;
    journal = await open(path.join(logDir, logName), 'wx', 0o600);
    const record = async (value: unknown) => {
      await journal!.writeFile(JSON.stringify(value) + '\n');
      await journal!.sync();
    };
    await record({
      event: 'planned',
      at: new Date().toISOString(),
      retentionHours: 24,
      candidates: batch.map((c) => ({ directory: c.directory, bytes: c.bytes })),
    });
    let removed = 0;
    for (const candidate of batch) {
      // A fresh, unfiltered DB snapshot is mandatory immediately before every removal.
      const success = await removeOrphanVersion(
        storage,
        candidate,
        await readStorageReferences(client),
      );
      if (success) removed++;
      await record({
        event: success ? 'removed' : 'retained_after_recheck',
        directory: candidate.directory,
      });
    }
    await record({
      event: 'finished',
      removed,
      remainingEligible: plan.eligible.length - batch.length,
    });
    console.log(
      `${removed} direktori versi orphan dihapus. Dokumen terdaftar/receipt selesai tetap dipertahankan. Jurnal: var/maintenance/${logName}`,
    );
  } finally {
    await journal?.close().catch(() => undefined);
    for (const key of locks.reverse())
      await client.query('SELECT pg_advisory_unlock($1,$2)', key).catch(() => undefined);
    client.release(true);
    await pool.end();
  }
}
main().catch(reportFailure);
