'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function DocumentAccess({
  documentId,
  candidates,
}: {
  documentId: string;
  candidates: { id: string; name: string; role: string; granted: boolean }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(id: string, grant: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/documents/${documentId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member: id, grant }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Perubahan gagal.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="source-evidence">
      <summary>Kelola grant dokumen sensitif</summary>
      <p>
        Berikan grant kepada reviewer dalam scope sebelum mengajukan versi Terbatas/Rahasia. Grant
        tidak memberi akses draft tanpa penugasan. Viewer tidak dapat menerima grant sensitif pada
        role bawaan.
      </p>
      <ul className="access-list">
        {candidates.map((c) => (
          <li key={c.id}>
            <span>
              <strong>{c.name}</strong> · {c.role}
            </span>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void save(c.id, !c.granted)}
            >
              {c.granted ? 'Cabut grant' : 'Berikan grant'}
            </button>
          </li>
        ))}
      </ul>
      {!candidates.length && <p>Belum ada calon penerima dalam scope.</p>}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </details>
  );
}
