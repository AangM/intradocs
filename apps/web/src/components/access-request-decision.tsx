'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from './toast';

/** Approve or decline one request. A note is required either way; SQL enforces it too. */
export function AccessRequestDecision({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/access-requests/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, note: note.trim() }),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Keputusan gagal disimpan.');
      toast(approve ? 'Permintaan disetujui' : 'Permintaan ditolak', approve ? 'ok' : 'warn');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workflow-fields">
      <input
        className="inp"
        value={note}
        maxLength={2000}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Catatan keputusan (wajib, min. 5 karakter)"
        aria-label="Catatan keputusan"
      />
      <div className="row">
        <button
          className="btn btn-p btn-sm"
          disabled={busy || note.trim().length < 5}
          onClick={() => void decide(true)}
        >
          Setujui
        </button>
        <button
          className="btn btn-sm btn-r"
          disabled={busy || note.trim().length < 5}
          onClick={() => void decide(false)}
        >
          Tolak
        </button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
