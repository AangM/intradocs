'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Raises an access request (V1 S02). The category list is whatever the server already
 * lets this person see; naming anything else fails at the RLS insert policy rather than
 * confirming the category exists.
 */
export function AccessRequestForm({ categories }: { categories: { id: string; name: string }[] }) {
  const router = useRouter();
  const id = useId();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [classification, setClassification] = useState<'restricted' | 'confidential'>('restricted');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const r = await fetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId, classification, reason: reason.trim() }),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Permintaan gagal.');
      setDone(true);
      setReason('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }

  if (!categories.length)
    return <p className="sub">Tidak ada kategori dalam scope Anda yang bisa dimintakan akses.</p>;

  return (
    <form onSubmit={(e) => void submit(e)} className="workflow-fields">
      <label htmlFor={`${id}-cat`}>Kategori</label>
      <select
        id={`${id}-cat`}
        className="inp"
        value={categoryId}
        disabled={busy}
        onChange={(e) => setCategoryId(e.target.value)}
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <fieldset disabled={busy} className="choice-group">
        <legend>Level akses yang diminta</legend>
        <label>
          <input
            type="radio"
            name={`${id}-level`}
            checked={classification === 'restricted'}
            onChange={() => setClassification('restricted')}
          />{' '}
          Terbatas
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-level`}
            checked={classification === 'confidential'}
            onChange={() => setClassification('confidential')}
          />{' '}
          Rahasia
        </label>
      </fieldset>
      <label htmlFor={`${id}-reason`}>Alasan (20–2000 karakter)</label>
      <textarea
        id={`${id}-reason`}
        className="inp"
        rows={3}
        value={reason}
        maxLength={2000}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Tugas atau kebutuhan kerja yang memerlukan akses ini…"
      />
      <p className="sub tiny">
        Persetujuan admin adalah keputusan tercatat, bukan pemberian akses otomatis: dokumen
        Terbatas/Rahasia tetap diberikan per dokumen oleh pemiliknya.
      </p>
      <div className="row">
        <button className="btn btn-p" disabled={busy || reason.trim().length < 20}>
          {busy ? 'Mengirim…' : 'Ajukan permintaan'}
        </button>
        {done && <span className="sub">Permintaan tercatat.</span>}
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </form>
  );
}
