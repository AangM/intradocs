import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalBlobStore, validateStorageKey, sha256 } from '../../packages/core/src/storage.ts';
const bytes = Buffer.from('# Dokumen sintetis\n');
for (const key of [
  '../outside',
  'a/../b',
  '/absolute',
  'a\\b',
  'a//b',
  'a/./b',
  'a/%2e%2e/b',
  'a\u0000b',
  'http://evil.test',
  'a/'.repeat(200),
])
  test(`invalid storage key ${JSON.stringify(key).slice(0, 50)}`, () =>
    assert.throws(() => validateStorageKey(key)));
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'intradocs-'));
  const store = new LocalBlobStore(path.join(dir, 'storage'));
  return { dir, store };
}
test('immutable content round-trip, checksum, and idempotent write', async () => {
  const { dir, store } = await fixture();
  try {
    const a = await store.putImmutable('documents/a/content.md', bytes);
    const b = await store.putImmutable('documents/a/content.md', bytes);
    assert.deepEqual(a, b);
    assert.equal(Buffer.from(await store.read(a.key, a.sha256)).toString(), bytes.toString());
    assert.equal(a.sha256, sha256(bytes));
    assert.equal(a.size, bytes.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('same version cannot be silently overwritten', async () => {
  const { dir, store } = await fixture();
  try {
    await store.putImmutable('a/content.md', bytes);
    await assert.rejects(store.putImmutable('a/content.md', Buffer.from('changed')));
    assert.equal(Buffer.from(await store.read('a/content.md')).toString(), bytes.toString());
    assert.deepEqual(await readdir(path.join(store.root, 'a')), ['content.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('tampering fails checksum verification', async () => {
  const { dir, store } = await fixture();
  try {
    const f = await store.putImmutable('a/content.md', bytes);
    await writeFile(path.join(store.root, f.key), 'tampered');
    await assert.rejects(store.read(f.key, f.sha256));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('read and write size bounds are enforced', async () => {
  const { dir, store } = await fixture();
  try {
    await assert.rejects(store.putImmutable('a.md', new Uint8Array(2 * 1024 * 1024 + 1)));
    await mkdir(store.root, { recursive: true });
    await writeFile(path.join(store.root, 'large.md'), new Uint8Array(2 * 1024 * 1024 + 1));
    await assert.rejects(store.read('large.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('symlink parent is rejected before creating anything outside storage', async (t) => {
  const { dir, store } = await fixture();
  try {
    await mkdir(store.root, { recursive: true });
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    try {
      await symlink(outside, path.join(store.root, 'linked'), 'dir');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('OS does not permit symlink creation');
        return;
      }
      throw e;
    }
    await assert.rejects(store.putImmutable('linked/nested/content.md', bytes));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('file symlinks cannot disclose an outside file', async (t) => {
  const { dir, store } = await fixture();
  try {
    await mkdir(store.root, { recursive: true });
    const outside = path.join(dir, 'outside.md');
    await writeFile(outside, 'private');
    try {
      await symlink(outside, path.join(store.root, 'alias.md'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('OS does not permit symlink creation');
        return;
      }
      throw e;
    }
    await assert.rejects(store.read('alias.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('concurrent same-byte writes are idempotent and leave no temp files', async () => {
  const { dir, store } = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.putImmutable('a/content.md', bytes)),
    );
    assert.equal(new Set(results.map((r) => r.sha256)).size, 1);
    assert.deepEqual(await readdir(path.join(store.root, 'a')), ['content.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
