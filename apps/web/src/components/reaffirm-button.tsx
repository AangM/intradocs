'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';
/**
 * The owner's "still valid" for a document whose review is near or past: one click
 * moves the review date by the category's cadence and clears the reminder, without a
 * new version going through review. Shown only when the server says it applies.
 */
export function ReaffirmButton({
  versionId,
  reviewAt,
  overdue,
}: {
  versionId: string;
  /** Already formatted ("21 Sep 2026"). */
  reviewAt: string;
  overdue: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await fetch(`/api/versions/${versionId}/reaffirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await r.json().catch(() => null)) as {
        reviewAt?: string;
        error?: string;
      } | null;
      if (!r.ok) {
        setNote(body?.error ?? 'Tidak dapat dikonfirmasi sekarang.');
        return;
      }
      setNote('Tercatat. Tanggal review berikutnya diperbarui.');
      router.refresh();
    } catch {
      setNote('Tidak dapat menghubungi server.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`reaffirm${overdue ? ' is-overdue' : ''}`}
      role="group"
      aria-label="Review berkala"
    >
      <Icon name={overdue ? 'alert' : 'clock'} size={16} />
      <div className="reaffirm-b">
        <strong>
          {overdue ? `Review terlewat sejak ${reviewAt}.` : `Review berkala ${reviewAt}.`}
        </strong>
        <span className="sub tiny">
          Masih akurat? Konfirmasi memajukan tanggal review tanpa versi baru; bila ada yang berubah,
          unggah revisi.
        </span>
        {note && (
          <span className="sub tiny" role="status">
            {note}
          </span>
        )}
      </div>
      <button type="button" className="btn btn-sm" onClick={confirm} disabled={busy}>
        <Icon name="check-c" size={14} />
        {busy ? 'Mencatat…' : 'Masih berlaku'}
      </button>
    </div>
  );
}
