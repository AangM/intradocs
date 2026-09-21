'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './icon';

interface Result {
  available: boolean;
  questions: string[];
  summary: string | null;
  currentSummary: string | null;
}

/**
 * What the local model generated about this document at ingest (V1, WeKnora summary and
 * question generation), shown the way label suggestions are: as proposals.
 *
 * Questions are offered to every reader as a way into the assistant, scoped to this
 * document; each one is still answered from validated citations or not at all. The
 * summary reaches only people who can revise the document, is labelled a draft, and is
 * never written anywhere -- a revision through review is the only way it becomes the
 * document's summary.
 */
export function DocumentInsights({
  documentId,
  editor,
}: {
  documentId: string;
  /** Whether the viewer may revise the document; controls the draft-summary block. */
  editor: boolean;
}) {
  const [state, setState] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/rag/document-insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          setFailed(true);
          return;
        }
        setState((await response.json()) as Result);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, [documentId]);

  if (failed || (state && !state.available)) return null;
  if (!state) return null;
  const hasQuestions = state.questions.length > 0;
  const hasSummary = editor && Boolean(state.summary);
  if (!hasQuestions && !hasSummary) return null;

  return (
    <section className="card" aria-label="Tanya asisten tentang dokumen ini">
      <div className="card-h">
        <Icon name="spark" size={17} />
        <h2 className="h3">Tanya asisten tentang dokumen ini</h2>
      </div>
      <div className="card-b">
        {hasQuestions && (
          <>
            <p className="sub tiny">
              Pertanyaan yang dijawab dokumen ini — jawabannya selalu dari kutipan yang divalidasi.
            </p>
            <ul className="insight-questions">
              {state.questions.map((question) => (
                <li key={question}>
                  <Link
                    href={`/ai-assistant?q=${encodeURIComponent(question)}&doc=${documentId}`}
                    prefetch={false}
                  >
                    <Icon name="msg" size={14} />
                    {question}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {hasSummary && (
          <details className="insight-summary">
            <summary>
              <Icon name="edit" size={13} />
              Draf ringkasan dari model
              <span className="pill p-amber">belum ditinjau</span>
            </summary>
            <p className="sub tiny">
              Dibuat mesin dari isi versi ini; bisa keliru. Tidak tampil kepada pembaca — bahan
              untuk revisi, yang tetap lewat review.
            </p>
            <blockquote
              className="insight-draft"
              tabIndex={0}
              aria-label="Draf ringkasan (dapat digulir)"
            >
              {state.summary}
            </blockquote>
            <div className="reader-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(state.summary ?? '')
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                <Icon name="file" size={14} />
                {copied ? 'Tersalin' : 'Salin draf'}
              </button>
              {state.currentSummary ? (
                <span className="sub tiny">
                  Ringkasan resmi saat ini: “{state.currentSummary.slice(0, 120)}
                  {state.currentSummary.length > 120 ? '…' : ''}”
                </span>
              ) : (
                <span className="sub tiny">Versi ini belum punya ringkasan resmi.</span>
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
