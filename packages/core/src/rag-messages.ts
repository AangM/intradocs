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
  'Tidak ada bagian dokumen yang menjawab pertanyaan ini secara langsung, jadi saya tidak menyusun jawaban sendiri.';

/**
 * The sentence the pinned agent's prompt tells the model to write when the passages it
 * was given do not contain the answer (scripts/weknora.ts pinAgent). The model is small
 * and paraphrases it ("Dokumentasi yang diberikan tidak membahas hal ini."), so
 * MODEL_DECLINE_PATTERN is what the reader-facing side actually matches on.
 */
export const MODEL_DECLINE_SENTENCE = 'Dokumen yang tersedia tidak membahas hal ini.';
export const MODEL_DECLINE_PATTERN =
  /^[\s*_#>-]*(?:dokumen(?:tasi)?|materi(?:\s+referensi)?)(?:\s+(?:yang\s+)?(?:tersedia|diberikan|ada|disediakan))?\s+tidak\s+membahas/i;
