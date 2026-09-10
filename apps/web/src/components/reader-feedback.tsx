'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';
export function ReaderFeedback({
  documentId,
  versionId,
  initialFavorite,
  initialFeedback,
}: {
  documentId: string;
  versionId: string;
  initialFavorite: boolean;
  initialFeedback: { helpful: boolean; comment: string } | null;
}) {
  const [favorite, setFavorite] = useState(initialFavorite),
    [helpful, setHelpful] = useState<boolean | null>(initialFeedback?.helpful ?? null),
    [comment, setComment] = useState(initialFeedback?.comment ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const router = useRouter();
  async function send(url: string, body: unknown) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error ?? 'Perubahan gagal.');
  }
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await send(`/api/documents/${documentId}/favorite`, { favorite: !favorite });
      setFavorite(!favorite);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan favorit.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (helpful === null) return;
    setBusy(true);
    setError('');
    try {
      await send('/api/feedback', { versionId, helpful, comment });
      setMessage('Terima kasih. Feedback tersimpan untuk pemilik dokumen.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan feedback.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reader-feedback" aria-label="Favorit dan feedback">
      <button className="btn" aria-pressed={favorite} disabled={busy} onClick={() => void toggle()}>
        <Icon name="star" />
        {favorite ? 'Hapus dari favorit' : 'Simpan favorit'}
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="h3">Apakah halaman ini membantu?</h2>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-pressed={helpful === true}
            onClick={() => setHelpful(true)}
          >
            Ya, membantu
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={helpful === false}
            onClick={() => setHelpful(false)}
          >
            Belum
          </button>
        </div>
        <label>
          Usulan perbaikan (opsional)
          <textarea
            className="inp"
            maxLength={2000}
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <button className="btn btn-p" disabled={busy || helpful === null}>
          Kirim feedback
        </button>
      </form>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
