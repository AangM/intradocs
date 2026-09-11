'use client';
import { useState } from 'react';
import { Icon } from './icon';

interface Result {
  available: boolean;
  suggested: string[];
  discarded: number;
  current: string[];
}

/**
 * Label suggestions from the RAG index (V1 S07).
 *
 * Nothing here applies anything. A published version's labels are frozen in the database,
 * so a suggestion can only be taken up by creating a revision — the model proposes and a
 * person decides. The panel says so plainly, because a suggestion that looks like a
 * setting invites people to trust it more than it deserves.
 */
export function LabelSuggestions({ documentId }: { documentId: string }) {
  const [state, setState] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/rag/label-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
        cache: 'no-store',
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(
          body &&
            typeof body === 'object' &&
            typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Permintaan gagal.',
        );
        return;
      }
      setState(body as Result);
    } catch {
      setError('Tidak dapat menghubungi layanan lokal.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card" aria-label="Saran label">
      <div className="card-h">
        <Icon name="spark" size={17} />
        <h2 className="h3">Saran label</h2>
      </div>
      <div className="card-b">
        <p className="sub tiny">
          Diusulkan oleh model lokal yang membaca isi dokumen, lalu disaring: hanya label yang sudah
          ada pada kategori dokumen ini yang ditampilkan. Saran tidak pernah diterapkan otomatis —
          label versi terbit dibekukan, jadi perubahannya lewat revisi baru.
        </p>
        {!state && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={pending}
          >
            <Icon name="spark" size={14} />
            {pending ? 'Memeriksa…' : 'Lihat saran'}
          </button>
        )}
        {error && (
          <div className="callout c-warn" role="alert">
            <Icon name="alert" size={16} />
            <div>{error}</div>
          </div>
        )}
        {state && !state.available && (
          <p className="sub tiny">
            Belum ada saran: dokumen ini belum terindeks untuk AI, atau AI Assistant sedang mati.
          </p>
        )}
        {state?.available && (
          <>
            {state.suggested.length === 0 ? (
              <p className="sub tiny">
                Tidak ada label baru yang diusulkan
                {state.current.length > 0 ? '; label saat ini dinilai sudah memadai' : ''}.
              </p>
            ) : (
              <div className="reader-actions">
                {state.suggested.map((label) => (
                  <span className="tag" key={label}>
                    {label}
                  </span>
                ))}
              </div>
            )}
            <p className="sub tiny">
              Label sekarang: {state.current.length > 0 ? state.current.join(', ') : '—'}.
              {state.discarded > 0
                ? ` ${state.discarded} usulan dibuang karena bukan label kategori ini.`
                : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
