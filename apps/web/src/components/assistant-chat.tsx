'use client';
import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from './icon';

export interface AssistantCitation {
  documentId: string;
  versionId: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  snippet: string;
  heading: string | null;
  href: string;
}

interface AssistantAnswer {
  mode: 'evidence-only' | 'generated';
  answer: string | null;
  abstained: boolean;
  citations: AssistantCitation[];
  rejectedCount: number;
  scopeSize: number;
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  public: 'Publik',
  internal: 'Internal',
  restricted: 'Terbatas',
  confidential: 'Rahasia',
};

export function AssistantChat({ maxQuestionChars }: { maxQuestionChars: number }) {
  const fieldId = useId();
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssistantAnswer | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/rag/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the question travels. The knowledge base, prompt, model and scope are
        // chosen on the server; sending them from here would not be honoured anyway.
        body: JSON.stringify({ question: trimmed }),
        signal: controller.signal,
        cache: 'no-store',
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body &&
          typeof body === 'object' &&
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Permintaan gagal.';
        setError(message);
        return;
      }
      setResult(body as AssistantAnswer);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('Tidak dapat menghubungi layanan lokal.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="chat-welcome">
        <span className="logo-mark">
          <Icon name="spark" size={25} />
        </span>
        <h2>Apa yang ingin Anda ketahui?</h2>
        <p className="sub">
          Jawaban hanya disusun dari dokumen final-approved yang boleh Anda baca. Tanpa sumber sah,
          IntraDocs menyatakan tidak tahu.
        </p>
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor={fieldId} className="sr-only">
          Pertanyaan AI
        </label>
        <textarea
          id={fieldId}
          value={question}
          maxLength={maxQuestionChars}
          disabled={pending}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Tanyakan sesuatu tentang dokumen yang boleh Anda baca…"
        />
        <footer>
          <span className="sub tiny">
            Sumber divalidasi ulang ke IntraDocs pada setiap permintaan; maksimal {maxQuestionChars}{' '}
            karakter.
          </span>
          <button className="btn btn-p" type="submit" disabled={pending || !question.trim()}>
            <Icon name="arrow-r" size={16} />
            {pending ? 'Mencari…' : 'Kirim'}
          </button>
        </footer>
      </form>

      <div className="rag-result" aria-live="polite" aria-busy={pending}>
        {pending && <p className="sub">Mengambil kandidat dan memvalidasi izin sumber…</p>}
        {error && (
          <div className="callout c-warn" role="alert">
            <Icon name="alert" size={18} />
            <div>{error}</div>
          </div>
        )}
        {result && (
          <>
            {result.answer && <p className="rag-answer">{result.answer}</p>}
            {result.abstained && !result.answer && (
              <p className="rag-answer">
                Tidak ada sumber resmi dalam cakupan akses Anda yang menjawab pertanyaan ini.
              </p>
            )}
            {result.citations.length > 0 && (
              <>
                <h3 className="rag-sources-title">Sumber ({result.citations.length})</h3>
                <ol className="rag-sources">
                  {result.citations.map((citation) => (
                    <li key={`${citation.versionId}-${citation.snippet.slice(0, 24)}`}>
                      <Link href={citation.href} prefetch={false} className="document-title">
                        {citation.documentTitle}
                      </Link>
                      <div className="sub tiny">
                        {citation.categoryName} · v{citation.versionLabel} ·{' '}
                        {CLASSIFICATION_LABELS[citation.classification] ?? citation.classification}
                        {citation.heading ? ` · ${citation.heading}` : ''}
                      </div>
                      <p className="rag-snippet">{citation.snippet}</p>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <p className="sub tiny">
              Cakupan retrieval: {result.scopeSize} versi aktif yang boleh Anda baca.
              {result.rejectedCount > 0
                ? ` ${result.rejectedCount} kandidat ditolak karena gagal validasi izin.`
                : ''}
            </p>
          </>
        )}
      </div>
    </>
  );
}
