import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../../packages/core/src/diff.ts';

test('identical text produces no hunks at all', () => {
  const r = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(r.identical, true);
  assert.equal(r.hunks.length, 0);
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
});

test('line endings alone are never reported as a change', () => {
  assert.equal(diffLines('a\r\nb\r\nc', 'a\nb\nc').identical, true);
});

test('a trailing newline difference is not a change', () => {
  assert.equal(diffLines('a\nb', 'a\nb\n').identical, true);
});

test('an inserted line is an addition and keeps both line numbers straight', () => {
  const r = diffLines('satu\ndua\n', 'satu\nbaru\ndua\n');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
  const lines = r.hunks.flatMap((h) => h.lines);
  const add = lines.find((l) => l.op === 'add')!;
  assert.equal(add.text, 'baru');
  assert.equal(add.left, null);
  assert.equal(add.right, 2);
  // The line after the insertion keeps its original number on the left.
  const dua = lines.find((l) => l.text === 'dua')!;
  assert.equal(dua.op, 'same');
  assert.equal(dua.left, 2);
  assert.equal(dua.right, 3);
});

test('a removed line is a removal', () => {
  const r = diffLines('satu\ndua\ntiga\n', 'satu\ntiga\n');
  assert.equal(r.removed, 1);
  assert.equal(r.added, 0);
  assert.equal(r.hunks.flatMap((h) => h.lines).find((l) => l.op === 'remove')!.text, 'dua');
});

test('a modified line shows as one removal plus one addition', () => {
  const r = diffLines('judul\nlama\nakhir\n', 'judul\nbaru\nakhir\n');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
});

test('unchanged regions far from a change are dropped, near ones kept as context', () => {
  const left = Array.from({ length: 40 }, (_, i) => `baris ${i}`).join('\n');
  const right = left.replace('baris 20', 'baris 20 diubah');
  const r = diffLines(left, right, { context: 2 });
  const shown = r.hunks.flatMap((h) => h.lines);
  assert(
    shown.some((l) => l.text === 'baris 18'),
    'context sebelum perubahan harus ada',
  );
  assert(
    shown.some((l) => l.text === 'baris 22'),
    'context sesudah perubahan harus ada',
  );
  assert(!shown.some((l) => l.text === 'baris 0'), 'baris jauh tidak perlu ditampilkan');
  assert.equal(r.hunks.length, 1);
});

test('two separate edits become two hunks', () => {
  const left = Array.from({ length: 60 }, (_, i) => `b${i}`).join('\n');
  const right = left.replace('b5\n', 'b5x\n').replace('b50\n', 'b50x\n');
  assert.equal(diffLines(left, right, { context: 1 }).hunks.length, 2);
});

test('a very long line is clamped instead of being emitted whole', () => {
  const r = diffLines('x\n', `${'y'.repeat(5000)}\n`, { maxLineChars: 40 });
  const add = r.hunks.flatMap((h) => h.lines).find((l) => l.op === 'add')!;
  assert.equal(add.text.length, 41, 'dipotong pada batas plus penanda elipsis');
  assert(add.text.endsWith('…'));
});

test('an oversized changed region is reported as truncated, not aligned line by line', () => {
  const left = Array.from({ length: 400 }, (_, i) => `kiri ${i}`).join('\n');
  const right = Array.from({ length: 400 }, (_, i) => `kanan ${i}`).join('\n');
  const r = diffLines(left, right, { maxAlign: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.added, 400);
  assert.equal(r.removed, 400);
});

test('a change confined to the middle does not re-align the whole document', () => {
  // Long identical head and tail: the aligner must stay inside the bound even though the
  // documents are far larger than maxAlign, because prefix and suffix are stripped first.
  const head = Array.from({ length: 3000 }, (_, i) => `h${i}`).join('\n');
  const tail = Array.from({ length: 3000 }, (_, i) => `t${i}`).join('\n');
  const r = diffLines(`${head}\ntengah lama\n${tail}`, `${head}\ntengah baru\n${tail}`, {
    maxAlign: 50,
  });
  assert.equal(r.truncated, false, 'wilayah yang berubah kecil, jadi tidak boleh terpotong');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
});

test('empty against non-empty is all additions', () => {
  const r = diffLines('', 'a\nb\n');
  assert.equal(r.added, 2);
  assert.equal(r.removed, 0);
  assert.equal(r.identical, false);
});
