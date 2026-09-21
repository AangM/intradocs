'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icon';

interface Insights {
  available: boolean;
  summary: string | null;
  currentSummary: string | null;
}
interface Labels {
  available: boolean;
  suggested: string[];
  discarded: number;
}

/**
 * Closes the loop from "the model proposed" to "a person used it": on the revision form,
 * the draft summary and the filtered label suggestions from the published version can be
 * copied into the fields with one press. They only ever land in this form; the revision
 * still goes through review before any of it becomes the document's metadata.
 */
export function RevisionSuggestions({
  documentId,
  currentSummary,
  currentLabels,
  onUseSummary,
  onAddLabel,
}: {
  documentId: string;
  currentSummary: string;
  currentLabels: string[];
  onUseSummary: (text: string) => void;
  onAddLabel: (name: string) => void;
}) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [labels, setLabels] = useState<Labels | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const post = (path: string) =>
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
        cache: 'no-store',
        signal: controller.signal,
      });
    Promise.all([post('/api/rag/document-insights'), post('/api/rag/label-suggestions')])
      .then(async ([a, b]) => {
        if (a.ok) setInsights((await a.json()) as Insights);
        if (b.ok) setLabels((await b.json()) as Labels);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [documentId]);

  const summary = insights?.available ? insights.summary : null;
  const newLabels = (labels?.available ? labels.suggested : []).filter(
    (l) => !currentLabels.some((c) => c.toLowerCase() === l.toLowerCase()),
  );
  if (!summary && newLabels.length === 0) return null;
  const summaryInUse = summary !== null && summary.trim() === currentSummary.trim();

  return (
    <section className="metadata-help" aria-label="Saran AI untuk revisi ini">
      <div className="hygiene-h">
        <Icon name="spark" size={15} />
        <strong>Saran AI untuk revisi ini</strong>
        <span className="pill p-amber">belum ditinjau</span>
      </div>
      <p className="sub tiny">
        Dihasilkan model lokal dari versi yang sudah terbit. Menekan tombol hanya mengisi kolom di
        form ini; revisi tetap melalui review sebelum menjadi metadata dokumen.
      </p>
      <div className="metadata-help-body">
        {summary && (
          <div>
            <strong className="tiny">Draf ringkasan:</strong>
            <blockquote
              className="insight-draft"
              tabIndex={0}
              aria-label="Draf ringkasan (dapat digulir)"
            >
              {summary}
            </blockquote>
            <button
              type="button"
              className="btn btn-sm"
              disabled={summaryInUse}
              onClick={() => onUseSummary(summary)}
            >
              <Icon name="edit" size={14} />
              {summaryInUse ? 'Sudah dipakai di kolom Ringkasan' : 'Gunakan sebagai ringkasan'}
            </button>
          </div>
        )}
        {newLabels.length > 0 && (
          <div>
            <strong className="tiny">Label kategori ini yang diusulkan:</strong>
            <div className="reader-actions">
              {newLabels.map((l) => (
                <button key={l} type="button" className="btn btn-sm" onClick={() => onAddLabel(l)}>
                  + {l}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
