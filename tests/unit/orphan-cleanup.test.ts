import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  lstat,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  planOrphanCleanup,
  removeOrphanVersion,
  ORPHAN_RETENTION_MS,
  type StorageReferences,
} from '../../packages/core/src/orphan-cleanup.ts';
let area: string;
before(async () => {
  area = await mkdtemp(path.join(os.tmpdir(), 'intradocs-gc-'));
});
after(async () => {
  await rm(area, { recursive: true, force: true });
});
async function fixture() {
  const root = path.join(area, randomUUID()),
    directory = `documents/${randomUUID()}/versions/${randomUUID()}`;
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, 'content.md'), '# Synthetic\n');
  return {
    root,
    directory,
    file: path.join(root, directory, 'content.md'),
    refs: { keys: [] as string[], activeVersions: [] as string[] } satisfies StorageReferences,
    now: Date.now() + ORPHAN_RETENTION_MS * 2,
  };
}
test('dry-run does not mutate old unreferenced bytes', async () => {
  const f = await fixture(),
    before = await readFile(f.file);
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 1);
  assert.deepEqual(await readFile(f.file), before);
});
test('unreferenced version is deleted only after a fresh matching inspection', async () => {
  const f = await fixture(),
    p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert(await removeOrphanVersion(f.root, p.eligible[0]!, f.refs, f.now));
  await assert.rejects(lstat(f.file));
  assert.equal((await planOrphanCleanup(f.root, f.refs, { nowMs: f.now })).eligible.length, 0);
});
test('live reference protects all representations, not just the referenced file', async () => {
  const f = await fixture();
  f.refs.keys.push(`${f.directory}/content.md`);
  await writeFile(path.join(f.root, f.directory, 'original.md'), 'original');
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 0);
  assert.equal(p.retained.referenced, 1);
});
test('active or completed receipt pin prevents cleanup', async () => {
  const f = await fixture();
  f.refs.activeVersions.push(f.directory);
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 0);
});
test('new and future-dated filesystem data is retained', async () => {
  const f = await fixture();
  const p = await planOrphanCleanup(f.root, f.refs);
  assert.equal(p.eligible.length, 0);
  assert.equal(p.retained.recent, 1);
});
test('reference acquired between plan and apply prevents deletion', async () => {
  const f = await fixture(),
    p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  f.refs.keys.push(`${f.directory}/content.md`);
  assert.equal(await removeOrphanVersion(f.root, p.eligible[0]!, f.refs, f.now), false);
  assert(await readFile(f.file));
});
test('mutated file or new child invalidates an earlier plan', async () => {
  const f = await fixture(),
    p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  await writeFile(f.file, 'CHANGED SYNTHETIC');
  assert.equal(await removeOrphanVersion(f.root, p.eligible[0]!, f.refs, f.now), false);
  assert.equal(await readFile(f.file, 'utf8'), 'CHANGED SYNTHETIC');
});
test('unrecognized files and nested directories are retained, not recursively removed', async () => {
  for (const kind of ['file', 'directory']) {
    const f = await fixture();
    if (kind === 'file') await writeFile(path.join(f.root, f.directory, 'important.txt'), 'keep');
    else await mkdir(path.join(f.root, f.directory, 'assets'));
    const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
    assert.equal(p.eligible.length, 0);
    assert.equal(p.retained.unsafe, 1);
  }
});
test('unknown or malformed DB reference aborts instead of filtering it away', async () => {
  const f = await fixture();
  await assert.rejects(
    planOrphanCleanup(f.root, { keys: ['../../secret'], activeVersions: [] }, { nowMs: f.now }),
  );
  await assert.rejects(
    planOrphanCleanup(
      f.root,
      { keys: ['legacy/document.md'], activeVersions: [] },
      { nowMs: f.now },
    ),
  );
  assert(await readFile(f.file));
});
test('version limit is explicit and does not silently claim a full scan', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, 'documents', randomUUID(), 'versions', randomUUID()), {
    recursive: true,
  });
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now, maxVersions: 1 });
  assert.equal(p.scanned, 1);
  assert.equal(p.truncated, true);
});
test('empty unreferenced version directory is safely removable after retention', async () => {
  const f = await fixture();
  await rm(f.file);
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible[0]?.bytes, 0);
  assert(await removeOrphanVersion(f.root, p.eligible[0]!, f.refs, f.now));
});
test('hardlinked artifact outside the version is not selected', async () => {
  const f = await fixture();
  await link(f.file, path.join(f.root, 'external-copy'));
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 0);
  assert.equal(p.retained.unsafe, 1);
});
test('interrupted immutable .tmp link in the same version can be cleaned', async () => {
  const f = await fixture();
  await link(f.file, path.join(f.root, f.directory, `.tmp-${randomUUID()}`));
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 1);
  assert(await removeOrphanVersion(f.root, p.eligible[0]!, f.refs, f.now));
});
test('symbolic-link entries cannot redirect deletion outside storage', async (t) => {
  const f = await fixture(),
    outside = path.join(area, randomUUID());
  await writeFile(outside, 'SYNTHETIC KEEP');
  try {
    await symlink(outside, path.join(f.root, f.directory, 'original.md'));
  } catch (e) {
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows symlink privilege is unavailable');
      return;
    }
    throw e;
  }
  const p = await planOrphanCleanup(f.root, f.refs, { nowMs: f.now });
  assert.equal(p.eligible.length, 0);
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC KEEP');
});
test('missing storage is a no-op and is not created', async () => {
  const root = path.join(area, randomUUID());
  assert.equal((await planOrphanCleanup(root, { keys: [], activeVersions: [] })).scanned, 0);
  await assert.rejects(readdir(root));
});
