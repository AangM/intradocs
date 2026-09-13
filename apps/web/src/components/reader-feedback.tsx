'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

async function send(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? 'Perubahan gagal.');
}

/** Star toggle for the reader's action row. */
export function FavoriteButton({
  documentId,
  initialFavorite,
}: {
  documentId: string;
  initialFavorite: boolean;
}) {
  const [favorite, setFavorite] = useState(initialFavorite),
    [busy, setBusy] = useState(false);
  const router = useRouter();
  async function toggle() {
    setBusy(true);
    try {
      await send(`/api/documents/${documentId}/favorite`, { favorite: !favorite });
      setFavorite(!favorite);
      router.refresh();
    } catch {
      /* the button keeps its previous state; nothing else to show for a failed toggle */
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className={`btn btn-sm ${favorite ? 'btn-on' : ''}`}
      aria-pressed={favorite}
      disabled={busy}
      onClick={() => void toggle()}
      title={favorite ? 'Hapus dari favorit' : 'Simpan ke favorit'}
    >
      <Icon name="star" size={15} />
      {favorite ? 'Favorit' : 'Simpan favorit'}
    </button>
  );
}

/**
 * "Apakah halaman ini membantu?" as one compact card (mockup S04). "Ya" is one click;
 * "Belum" and "Usulkan perbaikan" open a comment box, since those are the answers the
 * owner needs words for.
 */
export function ReaderFeedback({
  versionId,
  initialFeedback,
}: {
  versionId: string;
  initialFeedback: { helpful: boolean; comment: string } | null;
}) {
  const [helpful, setHelpful] = useState<boolean | null>(initialFeedback?.helpful ?? null),
    [comment, setComment] = useState(initialFeedback?.comment ?? ''),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function save(value: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await send('/api/feedback', { versionId, helpful: value, comment });
      setHelpful(value);
      setOpen(false);
      setMessage(
        value && !comment.trim()
          ? 'Terima kasih; jawaban Anda tersimpan untuk pemilik dokumen.'
          : 'Terima kasih; masukan Anda tersimpan untuk pemilik dokumen.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan feedback.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="feedback" aria-label="Feedback halaman">
      <div>
        <div className="feedback-t">Apakah halaman ini membantu?</div>
        <div className="sub tiny">Masukan Anda membantu pemilik dokumen memperbaiki isi.</div>
        {message && (
          <p role="status" className="success-message tiny">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
      <div className="row wrap">
        <button
          type="button"
          className={`btn btn-sm ${helpful === true ? 'btn-on' : ''}`}
          aria-pressed={helpful === true}
          disabled={busy}
          onClick={() => void save(true)}
        >
          <Icon name="thumb" size={14} /> Ya
        </button>
        <button
          type="button"
          className={`btn btn-sm ${helpful === false ? 'btn-on' : ''}`}
          aria-pressed={helpful === false}
          disabled={busy}
          onClick={() => {
            setHelpful(false);
            setOpen(true);
          }}
        >
          <Icon name="thumb" size={14} style={{ transform: 'rotate(180deg)' }} /> Belum
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="edit" size={14} /> Usulkan perbaikan
        </button>
      </div>
      {open && (
        <form
          className="feedback-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(helpful ?? false);
          }}
        >
          <label>
            <span className="sr-only">Usulan perbaikan</span>
            <textarea
              className="inp"
              maxLength={2000}
              rows={3}
              value={comment}
              placeholder="Apa yang kurang jelas, keliru, atau perlu ditambahkan?"
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="btn btn-p btn-sm" disabled={busy}>
              Kirim
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              Batal
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
