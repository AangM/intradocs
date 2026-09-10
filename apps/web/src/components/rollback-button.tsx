'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

/**
 * Opens a draft from an earlier version. Confirmation is required because the action
 * creates a new draft that the owner then has to shepherd through review; it is not
 * destructive, but it is not silent either.
 */
export function RollbackButton({
  documentId,
  versionId,
  label,
}: {
  documentId: string;
  versionId: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function restore() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/documents/${documentId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Pemulihan versi ditolak.');
        return;
      }
      router.refresh();
      router.push('/katalog?status=mine');
    } catch {
      setError('Tidak dapat menghubungi server. Coba lagi.');
    } finally {
      setBusy(false);
    }
  }

  if (!confirming)
    return (
      <>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          <Icon name="refresh" size={16} />
          Pulihkan v{label} sebagai draft
        </button>
      </>
    );

  return (
    <>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <p className="sub tiny">Draft baru akan dibuat dari v{label}. Lanjutkan?</p>
      <button type="button" className="btn btn-p" onClick={() => void restore()} disabled={busy}>
        {busy ? 'Memulihkan…' : 'Ya, buat draft'}
      </button>{' '}
      <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
        Batal
      </button>
    </>
  );
}
