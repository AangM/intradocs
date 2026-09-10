'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function NotificationRead({ id, read }: { id: string; read: boolean }) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function mark() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/notifications/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Gagal menyimpan.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {read ? (
        <span className="pill p-grey">Sudah dibaca</span>
      ) : (
        <button className="btn btn-sm" disabled={busy} onClick={() => void mark()}>
          {busy ? 'Menyimpan…' : 'Tandai dibaca'}
        </button>
      )}
      {error && (
        <p role="alert" className="upload-error">
          {error}
        </p>
      )}
    </div>
  );
}
