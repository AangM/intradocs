// Shared wording with no Node imports, so both the server modules and the browser
// bundle can use it. Kept separate from rag.ts, which pulls in node:crypto.

/** The one answer we are allowed to give when nothing survived validation. */
export const ABSTAIN_MESSAGE =
  'Tidak ada sumber resmi yang dapat Anda akses untuk menjawab pertanyaan ini. IntraDocs tidak menjawab tanpa bukti dokumen.';
