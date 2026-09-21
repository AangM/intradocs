// The shim between WeKnora's reranker call and text-embeddings-inference. Neither side is
// configurable, so this is the whole contract: WeKnora's {query, documents} in, TEI's
// {query, texts} out, TEI's [{index, score}] in, WeKnora's {results: [{index,
// relevance_score}]} out -- with indexes into the ORIGINAL documents. See WEKNORA.md §17.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripQuestionTail,
  toTeiBody,
  toWeknoraResults,
  isGeneratedSummary,
} from '../../scripts/rerank-shim.mjs';

test("WeKnora's generated-question paragraph is dropped before scoring, real text is kept", () => {
  // getEnrichedPassage appends "q1; q2" as the last paragraph of every passage.
  assert.equal(
    stripQuestionTail(
      'Cantumkan requirement dan risiko.\n\nApa yang wajib dicantumkan?; What is required?',
    ),
    'Cantumkan requirement dan risiko.',
  );
  // A paragraph that merely ends with a question has a sentence boundary before it.
  const prose = 'Backup harian.\n\nRestore diuji tiap bulan. Siapa yang menguji?';
  assert.equal(stripQuestionTail(prose), prose);
  // Nothing to strip, or nothing would be left: unchanged.
  assert.equal(stripQuestionTail('Satu paragraf saja.'), 'Satu paragraf saja.');
  assert.equal(stripQuestionTail('Hanya pertanyaan?'), 'Hanya pertanyaan?');
  assert.equal(stripQuestionTail('\n\nApa itu?'), '\n\nApa itu?');
});

test('the TEI request carries the cleaned texts and never rejects long input', () => {
  const body = toTeiBody('q', ['isi.\n\nTanya?', 'polos']);
  assert.deepEqual(body, {
    query: 'q',
    texts: ['isi.', 'polos'],
    raw_scores: false,
    truncate: true,
  });
});

test("TEI's reply becomes WeKnora's shape, best first, indexed into the original documents", () => {
  const documents = ['a.\n\nTanya?', 'b', 'c'];
  const results = toWeknoraResults(
    [
      { index: 2, score: 0.1 },
      { index: 0, score: 0.9 },
      { index: 7, score: 0.5 }, // out of range: dropped, never a crash
      { index: 1 }, // no score: 0
      'garbage',
    ],
    documents,
  );
  assert.deepEqual(results, [
    { index: 0, relevance_score: 0.9, document: { text: 'a.\n\nTanya?' } },
    { index: 2, relevance_score: 0.1, document: { text: 'c' } },
    { index: 1, relevance_score: 0, document: { text: 'b' } },
  ]);
  // Anything that is not an array is a 502 upstream, not an empty rerank.
  assert.equal(toWeknoraResults({ error: 'x' }, documents), null);
});

test('a generated "# Summary" chunk is never evidence: sent empty, scored zero', () => {
  const summary = '# Summary\nMasukkan akun uji dan verifikasi dua faktor (MFA) jika diperlukan.';
  const real = '## Langkah konfigurasi\n3. Masuk menggunakan akun uji dan MFA.';
  assert.equal(isGeneratedSummary(summary), true);
  assert.equal(
    isGeneratedSummary('Summary\nKonfigurasi VPN dilakukan dengan cara yang sama.'),
    true,
  );
  assert.equal(isGeneratedSummary(real), false);
  assert.equal(isGeneratedSummary('Ringkasan: # Summary bukan di awal'), false);
  const body = toTeiBody('MFA?', [summary, real]);
  assert.deepEqual(body.texts, ['', real]);
  const results = toWeknoraResults(
    [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.4 },
    ],
    [summary, real],
  );
  assert.deepEqual(
    results!.map((r) => [r.index, r.relevance_score]),
    [
      [1, 0.4],
      [0, 0],
    ],
  );
});
