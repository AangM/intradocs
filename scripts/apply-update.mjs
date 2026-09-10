// Conservative source updater. No dependency install, DB command, secret read, or data reset.
import {
  readdir,
  readFile,
  lstat,
  realpath,
  mkdir,
  copyFile,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function relativeFile(rel) {
  if (
    typeof rel !== 'string' ||
    path.isAbsolute(rel) ||
    rel.includes('\\') ||
    rel.split('/').some((p) => !p || p === '.' || p === '..') ||
    rel.includes(':')
  )
    throw new Error('Manifest path ditolak.');
  if (
    rel.split('/').some((p) => ['node_modules', '.git', '.next', 'var', 'artifacts'].includes(p)) ||
    path.basename(rel).startsWith('.env')
  )
    throw new Error('Manifest mencoba mengubah runtime/private file.');
  return rel;
}
async function safePath(root, rel) {
  relativeFile(rel);
  let current = root;
  for (const [i, part] of rel.split('/').entries()) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (i < rel.split('/').length - 1 && !stat.isDirectory()))
        throw new Error(`Symlink atau parent bukan direktori: ${rel}`);
    } catch (e) {
      if (e.code === 'ENOENT') break;
      throw e;
    }
  }
  return path.join(root, ...rel.split('/'));
}
async function hashFile(file) {
  try {
    return sha(await readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function main() {
  const args = process.argv.slice(2),
    index = args.indexOf('--target');
  if (
    index < 0 ||
    !args[index + 1] ||
    args.some((x, i) => !['--target', '--check', '--apply'].includes(x) && i !== index + 1)
  )
    throw new Error(
      'Gunakan node scripts/apply-update.mjs --target "FOLDER_PROJECT_LAMA" --check atau --apply.',
    );
  if (args.includes('--check') && args.includes('--apply'))
    throw new Error('Pilih hanya --check atau --apply; kedua mode tidak boleh digabung.');
  const target = await realpath(path.resolve(args[index + 1]));
  if (target === (await realpath(source)))
    throw new Error('Target harus folder project lama, bukan folder paket pembaruan ini.');
  if (
    !existsSync(path.join(target, 'package.json')) ||
    !existsSync(path.join(target, 'pnpm-workspace.yaml'))
  )
    throw new Error('Target bukan root project IntraDocs.');
  const manifest = JSON.parse(
    await readFile(path.join(source, 'scripts/update-manifest.json'), 'utf8'),
  );
  if (manifest.version !== '0.3.0' || !Array.isArray(manifest.files))
    throw new Error('Manifest pembaruan tidak dikenali.');
  const ownManifest = {
    path: 'scripts/update-manifest.json',
    beforeSha256s: manifest.previousManifestSha256s ?? [null],
    afterSha256: sha(await readFile(path.join(source, 'scripts/update-manifest.json'))),
  };
  const conflicts = [],
    changes = [];
  for (const [rel, expected] of Object.entries(manifest.protectedHashes)) {
    const actual = await hashFile(await safePath(target, rel));
    if (
      actual !== expected &&
      !(actual === null && (manifest.optionalProtected ?? []).includes(rel))
    )
      conflicts.push(rel + ' (baseline/migrasi berbeda)');
  }
  const migrationDir = await safePath(target, 'packages/db/migrations');
  for (const name of await readdir(migrationDir))
    if (
      name.endsWith('.sql') &&
      !Object.hasOwn(manifest.protectedHashes, 'packages/db/migrations/' + name)
    )
      conflicts.push('packages/db/migrations/' + name + ' (migrasi lokal tambahan perlu merge)');
  for (const file of [...manifest.files, ownManifest]) {
    const rel = relativeFile(file.path),
      src = await safePath(source, rel),
      dst = await safePath(target, rel);
    if ((await hashFile(src)) !== file.afterSha256)
      throw new Error(`Isi paket berubah: ${rel}. Unduh/ekstrak ulang paket.`);
    const current = await hashFile(dst);
    if (current === file.afterSha256) continue;
    if (!Array.isArray(file.beforeSha256s) || !file.beforeSha256s.includes(current)) {
      conflicts.push(rel);
      continue;
    }
    changes.push({ ...file, beforeSha256: current, src, dst });
  }
  if (conflicts.length)
    throw new Error(
      'Dibatalkan tanpa menulis file. Source lokal berbeda dari ZIP yang dikirim:\n' +
        conflicts.map((p) => ' - ' + p).join('\n') +
        '\nSimpan perubahan lokal dan minta merge; jangan paksa overwrite.',
    );
  console.log(
    `${changes.length} berkas source siap diperbarui. Baseline migrasi dan lockfile cocok (migrasi additive ditambahkan bila belum ada).`,
  );
  if (!args.includes('--apply')) {
    console.log(
      'Mode cek saja. Jika sudah menghentikan pnpm dev dan membackup folder, jalankan kembali dengan --apply.',
    );
    return;
  }
  if (!changes.length) {
    console.log('Pembaruan sudah terpasang; tidak ada file ditimpa.');
    return;
  }
  // All conflicts are checked before any mutation. Back up only source files that will change.
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  let backup = target;
  for (const part of ['var', 'update-backups', runId]) {
    backup = path.join(backup, part);
    if (existsSync(backup) && (await lstat(backup)).isSymbolicLink())
      throw new Error('Folder backup tidak boleh symlink.');
    await mkdir(backup, { recursive: true });
  }
  for (const file of changes)
    if (file.beforeSha256 !== null) {
      const out = path.join(backup, ...file.path.split('/'));
      await mkdir(path.dirname(out), { recursive: true });
      await copyFile(file.dst, out);
    }
  const applied = [];
  try {
    for (const file of changes) {
      const dst = await safePath(target, file.path);
      if ((await hashFile(dst)) !== file.beforeSha256)
        throw new Error('Source berubah selama pembaruan; hentikan editor dan coba ulang.');
      await mkdir(path.dirname(dst), { recursive: true });
      const temporary = dst + '.intradocs-update-' + randomUUID();
      try {
        const content = await readFile(file.src);
        if (sha(content) !== file.afterSha256)
          throw new Error('Paket source berubah saat update; dibatalkan.');
        await writeFile(temporary, content, { flag: 'wx' });
        await rename(temporary, dst);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      applied.push(file);
    }
  } catch (e) {
    // Best-effort rollback; backup is kept even if a restore fails. Never delete user data.
    const failed = [];
    for (const file of applied.reverse())
      try {
        if ((await hashFile(file.dst)) !== file.afterSha256) {
          failed.push(file.path);
          continue;
        }
        if (file.beforeSha256 === null) await unlink(file.dst);
        else await copyFile(path.join(backup, ...file.path.split('/')), file.dst);
      } catch {
        failed.push(file.path);
      }
    throw new Error(
      `Pembaruan gagal; rollback source dicoba. Backup: ${backup}${failed.length ? '\nPeriksa pemulihan: ' + failed.join(', ') : ''}\n${e.message}`,
    );
  }
  await writeFile(
    path.join(backup, 'update-record.json'),
    JSON.stringify({ version: manifest.version, files: changes.map((f) => f.path) }, null, 2),
  );
  console.log(
    'Source diperbarui. .env.local, file dokumen, credential, node_modules, dan volume DB tidak ditimpa.',
  );
  console.log(`Backup source: ${backup}`);
  console.log(
    'Di folder project lama: pnpm install --frozen-lockfile → pnpm db:migrate → pnpm knowledge:start → pnpm scanner:check → pnpm dev.',
  );
  console.log('Jangan menjalankan setup ulang atau menghapus volume database untuk update ini.');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
