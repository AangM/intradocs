// Operator-only, metadata-driven cleanup. Unknown layouts fail closed; no recursive rm.
import { lstat, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { validateStorageKey } from './storage.ts';
export const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${id}$`),
  versionPath = new RegExp(`^documents/${id}/versions/${id}$`);
const knownFile = new RegExp(
  `^(?:content\\.md|provenance\\.json|(?:original|attachment-[1-4])\\.(?:md|txt|pdf|docx|xlsx)|\\.tmp-${id})$`,
);
export interface StorageReferences {
  keys: readonly string[];
  activeVersions: readonly string[];
}
type Identity = {
  dev: string;
  ino: string;
  size: string;
  mtime: string;
  ctime: string;
  nlink: string;
};
export type OrphanCandidate = {
  directory: string;
  identity: Identity;
  files: Array<{ name: string; identity: Identity }>;
  bytes: number;
  lastChangedAt: number;
};
export type OrphanPlan = {
  scanned: number;
  eligible: OrphanCandidate[];
  retained: { referenced: number; recent: number; unsafe: number };
  truncated: boolean;
};
function stamp(s: Awaited<ReturnType<typeof lstat>>): Identity {
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    size: String(s.size),
    mtime: String(s.mtimeMs),
    ctime: String(s.ctimeMs),
    nlink: String(s.nlink),
  };
}
function same(a: Identity, b: Identity) {
  return Object.keys(a).every((k) => a[k as keyof Identity] === b[k as keyof Identity]);
}
function protect(refs: StorageReferences): Set<string> {
  const directories = new Set<string>();
  for (const key of refs.keys) {
    validateStorageKey(key);
    const parts = key.split('/');
    if (parts.length < 5 || !versionPath.test(parts.slice(0, 4).join('/')))
      throw new Error('Reference storage tidak dikenali; cleanup dibatalkan.');
    directories.add(parts.slice(0, 4).join('/'));
  }
  for (const key of refs.activeVersions) {
    if (!versionPath.test(key)) throw new Error('Lease storage tidak valid.');
    directories.add(key);
  }
  return directories;
}
async function rootDirectory(root: string): Promise<string | null> {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error('Root filesystem bukan storage.');
  try {
    const s = await lstat(resolved);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new Error('Root storage harus direktori biasa.');
    return await realpath(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
async function safeDirectory(root: string, key: string): Promise<string> {
  validateStorageKey(key);
  let current = root;
  for (const part of key.split('/')) {
    current = path.join(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('Layout storage tidak aman.');
  }
  return current;
}
async function inspect(root: string, key: string): Promise<OrphanCandidate> {
  if (!versionPath.test(key)) throw new Error('Hanya direktori versi yang dapat dibersihkan.');
  const directory = await safeDirectory(root, key),
    before = await lstat(directory),
    entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 8) throw new Error('Isi versi tidak dikenali.');
  const files: OrphanCandidate['files'] = [];
  let bytes = 0,
    lastChangedAt = Math.max(before.mtimeMs, before.ctimeMs);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!knownFile.test(entry.name) || entry.isSymbolicLink() || !entry.isFile())
      throw new Error('Berkas versi tidak dikenali.');
    const s = await lstat(path.join(directory, entry.name));
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.size >
        (/^(?:original|attachment-[1-4])\.(md|txt|pdf|docx|xlsx)$/.test(entry.name) ? 50 : 2) *
          1024 *
          1024
    )
      throw new Error('Artefak tidak aman.');
    files.push({ name: entry.name, identity: stamp(s) });
    bytes += s.size;
    lastChangedAt = Math.max(lastChangedAt, s.mtimeMs, s.ctimeMs);
  }
  for (const f of files) {
    const siblings = files.filter(
      (g) => g.identity.ino === f.identity.ino && g.identity.dev === f.identity.dev,
    ).length;
    if (Number(f.identity.nlink) > siblings)
      throw new Error('Hardlink di luar versi; pemeriksaan manual diperlukan.');
  }
  const after = await lstat(directory);
  if (!same(stamp(before), stamp(after))) throw new Error('Versi berubah selama pemeriksaan.');
  return { directory: key, identity: stamp(after), files, bytes, lastChangedAt };
}
export async function planOrphanCleanup(
  root: string,
  refs: StorageReferences,
  options: { nowMs?: number; maxVersions?: number } = {},
): Promise<OrphanPlan> {
  const protectedDirectories = protect(refs),
    now = options.nowMs ?? Date.now(),
    limit = options.maxVersions ?? 5000;
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 20000)
    throw new Error('Batas cleanup tidak valid.');
  const result: OrphanPlan = {
      scanned: 0,
      eligible: [],
      retained: { referenced: 0, recent: 0, unsafe: 0 },
      truncated: false,
    },
    canonical = await rootDirectory(root);
  if (!canonical) return result;
  let documents: string;
  try {
    documents = await safeDirectory(canonical, 'documents');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw e;
  }
  const dirs = await readdir(documents, { withFileTypes: true });
  if (dirs.length > 20000) throw new Error('Storage terlalu besar untuk cleanup lokal ini.');
  outer: for (const doc of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!uuid.test(doc.name) || doc.isSymbolicLink() || !doc.isDirectory()) {
      result.retained.unsafe++;
      continue;
    }
    let versions: string;
    try {
      versions = await safeDirectory(canonical, `documents/${doc.name}/versions`);
    } catch {
      result.retained.unsafe++;
      continue;
    }
    const entries = await readdir(versions, { withFileTypes: true });
    if (entries.length > 20000) throw new Error('Terlalu banyak versi; cleanup dibatalkan.');
    for (const v of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.scanned >= limit) {
        result.truncated = true;
        break outer;
      }
      result.scanned++;
      if (!uuid.test(v.name) || v.isSymbolicLink() || !v.isDirectory()) {
        result.retained.unsafe++;
        continue;
      }
      const key = `documents/${doc.name}/versions/${v.name}`;
      if (protectedDirectories.has(key)) {
        result.retained.referenced++;
        continue;
      }
      try {
        const candidate = await inspect(canonical, key);
        if (now - candidate.lastChangedAt < ORPHAN_RETENTION_MS) result.retained.recent++;
        else result.eligible.push(candidate);
      } catch {
        result.retained.unsafe++;
      }
    }
  }
  return result;
}
export async function removeOrphanVersion(
  root: string,
  candidate: OrphanCandidate,
  refs: StorageReferences,
  nowMs = Date.now(),
): Promise<boolean> {
  if (protect(refs).has(candidate.directory)) return false;
  const canonical = await rootDirectory(root);
  if (!canonical) return false;
  let current: OrphanCandidate;
  try {
    current = await inspect(canonical, candidate.directory);
  } catch {
    return false;
  }
  if (
    !Number.isFinite(nowMs) ||
    nowMs - current.lastChangedAt < ORPHAN_RETENTION_MS ||
    !same(current.identity, candidate.identity) ||
    current.files.length !== candidate.files.length ||
    current.files.some(
      (f, i) =>
        f.name !== candidate.files[i]?.name || !same(f.identity, candidate.files[i]!.identity),
    )
  )
    return false;
  const removedLinks = new Map<string, number>();
  for (const file of current.files) {
    const directory = await safeDirectory(canonical, current.directory),
      target = path.join(directory, file.name),
      s = await lstat(target),
      observed = stamp(s),
      inode = `${file.identity.dev}:${file.identity.ino}`,
      removed = removedLinks.get(inode) ?? 0;
    // Removing a sibling hardlink changes nlink/ctime, but never bytes, inode, size or mtime.
    const unchanged = ['dev', 'ino', 'size', 'mtime'].every(
      (k) => observed[k as keyof Identity] === file.identity[k as keyof Identity],
    );
    if (
      s.isSymbolicLink() ||
      !s.isFile() ||
      !unchanged ||
      Number(observed.nlink) !== Number(file.identity.nlink) - removed ||
      (removed === 0 && observed.ctime !== file.identity.ctime)
    )
      throw new Error('Artefak berubah saat cleanup; operasi dihentikan.');
    await unlink(target);
    removedLinks.set(inode, removed + 1);
  }
  await rmdir(await safeDirectory(canonical, current.directory));
  return true;
}
