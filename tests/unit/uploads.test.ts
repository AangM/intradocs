import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  parseDraftMetadata,
  validateTextFile,
  validateDocumentFile,
  LOCAL_FORMATS,
  convertText,
  uploadFingerprint,
  UPLOAD_LIMITS,
  UploadError,
  digest,
} from '../../packages/core/src/uploads.ts';
import { parseUploadRequest, readUploadBytes } from '../../packages/core/src/upload-request.ts';
import { BodyLimitError } from '../../packages/core/src/http-input.ts';
const meta = {
  title: 'Panduan contoh',
  summary: 'Teks sintetis',
  categoryId: '10000000-0000-4000-8000-000000000001',
  classification: 'internal',
  labels: ['Runbook'],
  synthetic: true,
};
const input = (name = 'demo.md', text = '# Halo\n') =>
  validateTextFile(name, 'text/plain', Buffer.from(text));
const failure = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof UploadError && e.code === code);
test('metadata trims and canonicalizes label duplicates, not source frontmatter', () => {
  const m = parseDraftMetadata({
    ...meta,
    title: ' Panduan contoh ',
    labels: ['Runbook', 'Panduan', 'Runbook'],
  });
  assert.equal(m.title, meta.title);
  assert.deepEqual(m.labels, ['Panduan', 'Runbook']);
});
test('summary supports bounded multiline text', () =>
  assert.equal(
    parseDraftMetadata({ ...meta, summary: 'Baris satu\r\nBaris dua' }).summary,
    'Baris satu\nBaris dua',
  ));
for (const patch of [
  { ownerId: 'spoof' },
  { status: 'published' },
  { role: 'super_admin' },
  { classification: 'PUBLIC' },
  { classification: 'unknown' },
  { synthetic: false },
  { title: 'x' },
  { title: 'x'.repeat(181) },
  { summary: 'x'.repeat(1001) },
  { title: 'hidden\u202etext' },
  { labels: ['x'] },
  { labels: Array(9).fill('label') },
  { labels: { admin: true } },
])
  test(`metadata boundary rejects ${Object.keys(patch)[0]} ${JSON.stringify(patch).slice(0, 65)}`, () =>
    assert.throws(() => parseDraftMetadata({ ...meta, ...patch })));
for (const name of [
  '../demo.md',
  'a\\b.md',
  'C:demo.md',
  '.hidden.md',
  'demo.md ',
  'demo.md\u202eexe',
  'x.exe',
  'demo.md.exe',
  'file.zip',
  'file.mdx',
  'http://x.md',
])
  test(`filename/format rejected: ${JSON.stringify(name)}`, () => assert.throws(() => input(name)));
test('uppercase extensions, Unicode name, empty browser MIME accepted', () => {
  assert.equal(validateTextFile('Panduan-日本.MD', '', Buffer.from('Halo')).format, 'MD');
});
test('empty and oversized bytes rejected', () => {
  failure(() => input('demo.md', ''), 'empty_file');
  failure(
    () => validateTextFile('demo.md', '', new Uint8Array(UPLOAD_LIMITS.fileBytes + 1)),
    'file_too_large',
  );
});
test('misleading MIME is not authoritative', () =>
  failure(
    () => validateTextFile('demo.md', 'application/javascript', Buffer.from('hello')),
    'unsupported_format',
  ));
for (const magic of [
  Buffer.from('%PDF-1.7'),
  Buffer.from([80, 75, 3, 4]),
  Buffer.from([0x7f, 69, 76, 70]),
  Buffer.from('MZ binary'),
])
  test(`binary magic rejected (${magic.toString('hex')})`, () =>
    failure(() => validateTextFile('fake.md', 'text/plain', magic), 'unsupported_format'));
test('canonical MD preserves content, tables and frontmatter as data', () => {
  const raw =
    '---\nrole: super_admin\nclassification: public\nstatus: published\n---\n# SOP\n\n| A | B |\n|---|---|\n| 10 | 20 |\n';
  const file = input('demo.md', raw),
    out = convertText(file);
  assert.equal(Buffer.from(out.markdown).toString(), raw);
  assert.equal(out.sha256, digest(Buffer.from(raw)));
  assert.equal(parseDraftMetadata(meta).classification, 'internal');
});
test('BOM and CRLF normalize with honest one-to-one line mapping', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# Judul\r\nIsi\rAkhir'),
  ]);
  const f = validateTextFile('demo.md', '', bytes),
    out = convertText(f);
  assert.equal(Buffer.from(out.markdown).toString(), '# Judul\nIsi\nAkhir');
  assert.deepEqual(out.mapping, { sourceStart: 1, sourceEnd: 3, markdownStart: 1, markdownEnd: 3 });
  assert.equal(f.sha256, digest(bytes));
  assert.equal(out.normalizations.length, 2);
});
test('TXT cannot break out of its literal fence or execute HTML/Markdown', () => {
  const raw = '```\n<script>x</script>\n````\n# Not a heading';
  const out = convertText(input('demo.txt', raw));
  const md = Buffer.from(out.markdown).toString();
  assert.equal(md, '`````text\n' + raw + '\n`````\n');
  assert.equal(out.mapping.markdownStart, 2);
  assert.equal(out.mapping.sourceEnd, 4);
});
test('invalid UTF-8 is rejected, not silently replaced', () =>
  failure(
    () => convertText(validateTextFile('demo.md', '', new Uint8Array([0xc3, 0x28]))),
    'invalid_encoding',
  ));
for (const text of ['hello\0world', 'a\u001bb', 'a\u000bb', ' \n\t '])
  test(`non-text/empty content rejected ${JSON.stringify(text)}`, () =>
    assert.throws(() => convertText(input('demo.txt', text))));
test('line length and count have deterministic resource bounds', () => {
  failure(
    () => convertText(input('demo.md', 'x'.repeat(UPLOAD_LIMITS.lineCharacters + 1))),
    'text_complexity',
  );
  failure(
    () => convertText(input('demo.md', 'x\n'.repeat(UPLOAD_LIMITS.lines))),
    'text_complexity',
  );
});
test('fingerprint binds bytes, filename, metadata, classification policy and pipeline', () => {
  const f = input(),
    m = parseDraftMetadata(meta),
    hash = uploadFingerprint(f, m);
  assert.equal(hash, uploadFingerprint(f, m));
  assert.notEqual(hash, uploadFingerprint(input('other.md'), m));
  assert.notEqual(hash, uploadFingerprint(input('demo.md', 'changed'), m));
  assert.notEqual(hash, uploadFingerprint(f, { ...m, title: 'Judul berbeda' }));
});
function request(edit?: (form: FormData) => void) {
  const form = new FormData();
  form.set('file', new Blob(['# Demo\n'], { type: 'text/markdown' }), 'demo.md');
  for (const [k, v] of Object.entries(meta))
    form.set(k, k === 'labels' ? JSON.stringify(v) : String(v));
  edit?.(form);
  return new Request('http://localhost/api/documents/drafts', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: form,
  });
}
test('native multipart parsing retains exact original bytes', async () => {
  const v = await parseUploadRequest(request());
  assert.equal(v.name, 'demo.md');
  assert.equal(Buffer.from(v.bytes).toString(), '# Demo\n');
  assert.equal(v.metadata.title, meta.title);
});
for (const [label, edit] of [
  ['duplicate file', (f: FormData) => f.append('file', new Blob(['x']), 'x.md')],
  ['duplicate title', (f: FormData) => f.append('title', 'two')],
  ['actor injection', (f: FormData) => f.set('actorId', 'spoof')],
  ['file as string', (f: FormData) => f.set('file', 'not a file')],
  ['labels not JSON', (f: FormData) => f.set('labels', 'broken')],
  ['missing field', (f: FormData) => f.delete('summary')],
] as const)
  test(`multipart rejects ${label}`, async () => assert.rejects(parseUploadRequest(request(edit))));
test('oversized multipart file rejected', async () =>
  assert.rejects(
    parseUploadRequest(
      request((f) =>
        f.set('file', new Blob([new Uint8Array(UPLOAD_LIMITS.fileBytes + 1)]), 'huge.md'),
      ),
    ),
    BodyLimitError,
  ));
test('binary body limit does not trust a false content length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(20));
    },
    cancel() {
      cancelled = true;
    },
  });
  const r = new Request('http://localhost', {
    method: 'POST',
    body: stream,
    headers: { 'content-length': '1' },
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(readUploadBytes(r, 10), BodyLimitError);
  assert(cancelled);
});
test('slow body is cancelled by an overall deadline', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const r = new Request('http://localhost', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(
    readUploadBytes(r, 100, 20),
    (e: unknown) => e instanceof UploadError && e.code === 'upload_timeout',
  );
  assert(cancelled);
});

test('binary formats are gated by the accepted list, the extension, the MIME and the first bytes', () => {
  const pdf = Buffer.from('%PDF-1.7 synthetic');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const html = Buffer.from('﻿  <!doctype html><html><body><p>hi</p></body></html>');
  assert.equal(validateDocumentFile('a.pdf', 'application/pdf', pdf).format, 'PDF');
  assert.equal(validateDocumentFile('a.html', 'text/html', html).format, 'HTML');
  assert.equal(validateDocumentFile('a.html', '', html).format, 'HTML');
  // HTML must start with '<' (after BOM/whitespace); a PDF body under .html is refused.
  failure(() => validateDocumentFile('a.html', 'text/html', pdf), 'unsupported_format');
  // PPTX is a zip, but only when the installation lists it (WeKnora parser present).
  failure(() => validateDocumentFile('deck.pptx', '', zip), 'unsupported_format');
  assert.equal(
    validateDocumentFile('deck.pptx', '', zip, [...LOCAL_FORMATS, 'PPTX']).format,
    'PPTX',
  );
  // The error names what is accepted, so the person is not told PPTX works when it does not.
  assert.throws(
    () => validateDocumentFile('deck.pptx', '', zip),
    (e: unknown) => e instanceof UploadError && !e.message.includes('PPTX'),
  );
});
