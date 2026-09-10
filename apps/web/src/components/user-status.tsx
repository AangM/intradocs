'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function UserStatus({ id, active, own }: { id: string; active: boolean; own: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change() {
    if (
      !window.confirm(
        `${active ? 'Nonaktifkan' : 'Aktifkan'} akun ini?${active ? ' Semua session akun akan dicabut.' : ''}`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/users/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      });
      if (!r.ok) throw new Error();
      router.refresh();
    } catch {
      setError('Perubahan gagal. Muat ulang status sebelum mencoba lagi.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button
        className={`btn btn-sm ${active ? 'btn-r' : ''}`}
        disabled={busy || own}
        title={own ? 'Akun sendiri tidak dapat dinonaktifkan' : undefined}
        onClick={change}
      >
        {busy ? 'Menyimpan…' : active ? 'Nonaktifkan' : 'Aktifkan'}
      </button>
      {error && (
        <p role="alert" className="inline-error tiny">
          {error}
        </p>
      )}
    </div>
  );
}
