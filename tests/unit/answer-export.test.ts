import test from 'node:test';
import assert from 'node:assert/strict';
import { answerToMarkdown } from '../../packages/core/src/answer-export.ts';
import { ABSTAIN_MESSAGE } from '../../packages/core/src/rag-messages.ts';

const at = new Date('2026-01-02T03:04:05.000Z');
const citation = {
  documentTitle: 'Konfigurasi VPN',
  versionLabel: '1.0',
  classification: 'internal',
  categoryName: 'Infrastruktur',
  heading: 'Langkah konfigurasi',
  snippet: 'Buka aplikasi VPN pada perangkat uji.',
  href: '/dokumen/abc/konfigurasi-vpn#langkah',
};

test('an exported answer carries the question, the answer and its sources', () => {
  const md = answerToMarkdown({
    question: 'Bagaimana konfigurasi VPN?',
    answer: 'Ikuti empat langkah pada dokumen sumber.',
    abstained: false,
    citations: [citation],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  assert(md.startsWith('# Bagaimana konfigurasi VPN?'));
  assert(md.includes('Ikuti empat langkah'));
  assert(md.includes('**Konfigurasi VPN**'));
  assert(md.includes('v1.0 · Infrastruktur · internal · Langkah konfigurasi'));
  assert(md.includes('2026-01-02T03:04:05.000Z'));
});

test('citation links are absolute so they still resolve outside the app', () => {
  const md = answerToMarkdown({
    question: 'q',
    answer: 'a',
    abstained: false,
    citations: [citation],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  assert(md.includes('<http://localhost:3000/dokumen/abc/konfigurasi-vpn#langkah>'));
  // Still an IntraDocs URL: opening it goes through the same permission check.
  assert(!md.includes('](/dokumen'), 'jangan tinggalkan path relatif yang tidak dapat dibuka');
});

test('an abstention exports the abstention, never an empty answer that looks confident', () => {
  const md = answerToMarkdown({
    question: 'Berapa harga saham?',
    answer: null,
    abstained: true,
    citations: [],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  assert(md.includes(ABSTAIN_MESSAGE));
  assert(!md.includes('## Sumber'));
});

test('retrieval-only mode says so rather than presenting sources as an answer', () => {
  const md = answerToMarkdown({
    question: 'q',
    answer: '',
    abstained: false,
    citations: [citation],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  assert(md.includes('Mode retrieval-only'));
  assert(md.includes('## Sumber (1)'));
});

test('document text is fenced, so a snippet cannot restructure the exported file', () => {
  const hostile = {
    ...citation,
    snippet: '## Judul palsu\n![gambar](http://attacker.test/pixel.png)\n```\nkode\n```',
  };
  const md = answerToMarkdown({
    question: 'q',
    answer: 'a',
    abstained: false,
    citations: [hostile],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  // The only headings are the ones this function wrote; the snippet's own "## Judul
  // palsu" stays indented inside the fence and never becomes document structure.
  const headings = md.split('\n').filter((l) => /^#{1,6}\s/.test(l));
  assert.deepEqual(headings, ['# q', '## Sumber (1)']);
  assert(!headings.includes('## Judul palsu'));
  // The image reference survives as text inside the fence but is not left able to close it.
  assert(!md.includes('\n```\n'), 'fence dokumen tidak boleh ditutup lebih awal');
  assert(md.includes("'''"), 'fence di dalam snippet dinetralkan');
});

test('newlines in a title or heading cannot break the list structure', () => {
  const md = answerToMarkdown({
    question: 'baris satu\nbaris dua',
    answer: 'a',
    abstained: false,
    citations: [{ ...citation, documentTitle: 'Judul\nJahat', heading: 'A\nB' }],
    origin: 'http://localhost:3000',
    generatedAt: at,
  });
  assert(md.startsWith('# baris satu baris dua\n'));
  assert(md.includes('**Judul Jahat**'));
  assert(md.includes('· A B'));
});
