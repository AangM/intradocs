'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from './toast';

/**
 * Activate or deactivate one account. The confirmation is inline (a native confirm() is
 * suppressed by some embedded browsers), and the destructive button stays quiet until
 * hovered so seven of them in a table do not outshout the page's one primary action.
 */
export function UserStatus({ id, active, own }: { id: string; active: boolean; own: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  async function change() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/users/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      });
      if (!r.ok) throw new Error();
      toast(active ? 'Akun dinonaktifkan' : 'Akun diaktifkan', active ? 'warn' : 'ok');
      router.refresh();
    } catch {
      setError('Perubahan gagal. Muat ulang status sebelum mencoba lagi.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  if (confirming)
    return (
      <div className="row" role="group" aria-label="Konfirmasi">
        <span className="sub tiny">{active ? 'Cabut semua sesi?' : 'Aktifkan akun?'}</span>
        <button
          type="button"
          className={`btn btn-sm ${active ? 'btn-danger' : 'btn-p'}`}
          disabled={busy}
          onClick={() => void change()}
        >
          {busy ? 'Menyimpan…' : 'Ya'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Batal
        </button>
      </div>
    );
  return (
    <div>
      <button
        type="button"
        className={`btn btn-sm ${active ? 'btn-r' : ''}`}
        disabled={busy || own}
        title={own ? 'Akun sendiri tidak dapat dinonaktifkan' : undefined}
        onClick={() => setConfirming(true)}
      >
        {active ? 'Nonaktifkan' : 'Aktifkan'}
      </button>
      {error && (
        <p role="alert" className="inline-error tiny">
          {error}
        </p>
      )}
    </div>
  );
}
