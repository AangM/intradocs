import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, open, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore, StoredFile } from './ports.ts';
export function validateStorageKey(key: string): string {
  if (
    !key ||
    key.length > 300 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('..') ||
    !/^[a-zA-Z0-9_./-]+$/.test(key) ||
    key.split('/').some((s) => !s || s === '.')
  )
    throw new Error('Storage key tidak valid.');
  return key;
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function limitFor(key: string) {
  return /\/(?:original|attachment-[1-4])\.(md|txt|pdf|docx|xlsx)$/.test(key)
    ? 50 * 1024 * 1024
    : 2 * 1024 * 1024;
}
export class LocalBlobStore implements BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private async within(key: string, forWrite = false): Promise<string> {
    validateStorageKey(key);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('Root storage tidak boleh berupa symlink.');
    const root = await realpath(this.root);
    const parts = key.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      if (forWrite)
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error('Parent storage tidak valid.');
    }
    const destination = path.join(directory, parts.at(-1)!);
    if (!destination.startsWith(root + path.sep)) throw new Error('Storage path di luar root.');
    if (!forWrite) {
      const entry = await lstat(destination);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > limitFor(key))
        throw new Error('Artefak tidak valid.');
    }
    return destination;
  }
  async putImmutable(key: string, bytes: Uint8Array): Promise<StoredFile> {
    if (bytes.byteLength > limitFor(key)) throw new Error('Artefak melebihi batas penyimpanan.');
    const destination = await this.within(key, true);
    const hash = sha256(bytes);
    const temporary = path.join(path.dirname(destination), `.tmp-${randomUUID()}`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, destination);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (sha256(await this.read(key)) !== hash)
          throw new Error('Versi immutable tidak boleh ditimpa.');
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    // POSIX directory sync; hardware/power-loss acceptance remains separate.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { key, sha256: hash, size: bytes.byteLength };
  }
  async read(key: string, expectedHash?: string): Promise<Uint8Array> {
    const file = await this.within(key);
    const bytes = await readFile(file);
    if (bytes.length > limitFor(key)) throw new Error('Artefak terlalu besar.');
    if (expectedHash && sha256(bytes) !== expectedHash)
      throw new Error('Integritas artefak gagal.');
    return bytes;
  }
}
