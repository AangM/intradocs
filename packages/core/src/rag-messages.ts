// Shared wording with no Node imports, so both the server modules and the browser
// bundle can use it. Kept separate from rag.ts, which pulls in node:crypto.

/** The one answer we are allowed to give when nothing survived validation. */
export const ABSTAIN_MESSAGE =
  'Tidak ada sumber resmi yang dapat Anda akses untuk menjawab pertanyaan ini. IntraDocs tidak menjawab tanpa bukti dokumen.';

/**
 * WeKnora's own pipeline -- its retrieval thresholds and, when a reranker is on, the
 * reranker -- found no chunk worth answering from and emitted the fixed fallback, while
 * IntraDocs' gate had passed some passages. Said as exactly that, next to the sources.
 */
export const NO_DIRECT_ANSWER_MESSAGE =
  'Tidak ada bagian dokumen yang menjawab pertanyaan ini secara langsung, jadi tidak ada jawaban yang disusun. Sumber terdekat yang boleh Anda baca tercantum di bawah.';
