// WeKnora's in-process parser as a PPTX converter: the pure parts. The network path is
// exercised end to end by var/upload-flow against a running WeKnora (WEKNORA.md §27).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleParsedMarkdown,
  slideMappings,
  toConvertedText,
} from '../../packages/core/src/weknora-parse.ts';

test('chunks are joined in order and one locator is produced per slide heading', () => {
  const markdown = assembleParsedMarkdown([
    { chunkIndex: 1, content: '## Checklist Minggu Pertama\n\nAktifkan MFA.\n' },
    { chunkIndex: 0, content: '## Onboarding (SINTETIS)\r\n\r\nHari pertama: akun uji.\n\n\n\n' },
  ]);
  assert.equal(
    markdown,
    '## Onboarding (SINTETIS)\n\nHari pertama: akun uji.\n\n## Checklist Minggu Pertama\n\nAktifkan MFA.\n',
  );
  assert.deepEqual(slideMappings(markdown), [
    { kind: 'page', locator: 'slide:1', markdownStart: 1, markdownEnd: 4 },
    { kind: 'page', locator: 'slide:2', markdownStart: 5, markdownEnd: 7 },
  ]);
  const converted = toConvertedText(markdown);
  assert.equal(converted.pipeline, 'weknora-parse-v1');
  assert.equal(converted.lineCount, 8);
  assert.equal(Buffer.from(converted.markdown).toString('utf8'), markdown);
  assert.match(converted.warnings?.[0] ?? '', /parser WeKnora/);
});

test('text before the first heading is slide 1; an empty parse is a conversion failure, not an empty draft', () => {
  assert.deepEqual(slideMappings('Catatan tanpa judul.\n\n## Slide dua\n\nIsi.\n'), [
    { kind: 'page', locator: 'slide:1', markdownStart: 1, markdownEnd: 2 },
    { kind: 'page', locator: 'slide:2', markdownStart: 3, markdownEnd: 5 },
  ]);
  assert.throws(() => toConvertedText('  \n'), /Tidak ditemukan teks/);
});
