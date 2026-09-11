'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

/**
 * Marks the current document as required reading for its own category (V1 S06).
 *
 * The category is fixed to the document's: a requirement is an instruction to the people
 * who can already read the document, and pointing it anywhere else would announce the
 * document to people it then refuses to show. The insert policy enforces the same.
 */
export function RequiredReadingMark({
  documentId,
  categoryId,
  categoryName,
}: {
  documentId: string;
  categoryId: string;
  categoryName: string;
}) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/required-reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId,
          categoryId,
          note: note.trim(),
          dueAt: dueAt ? new Date(`${dueAt}T23:59:59`).toISOString() : null,
        }),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Gagal menandai.');
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="source-evidence">
      <summary>Jadikan bacaan wajib untuk {categoryName}</summary>
      {done ? (
        <p className="sub">Ditandai. Semua orang dengan scope {categoryName} akan melihatnya.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="workflow-fields">
          <label htmlFor={`${id}-note`}>Mengapa dokumen ini wajib dibaca (10–500 karakter)</label>
          <textarea
            id={`${id}-note`}
            className="inp"
            rows={2}
            value={note}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <label htmlFor={`${id}-due`}>Tenggat (opsional)</label>
          <input
            id={`${id}-due`}
            type="date"
            className="inp"
            value={dueAt}
            disabled={busy}
            onChange={(e) => setDueAt(e.target.value)}
          />
          <button className="btn btn-sm btn-p" disabled={busy || note.trim().length < 10}>
            <Icon name="check" size={14} />
            {busy ? 'Menyimpan…' : 'Tandai wajib dibaca'}
          </button>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </form>
      )}
    </details>
  );
}
