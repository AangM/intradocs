'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

type DiffEntry = {
  externalId: string;
  name: string;
  kind: string;
  change: 'created' | 'updated';
  fields: Record<string, [unknown, unknown]>;
};
type Preview = {
  format: 'xmi' | 'csv';
  sha256: string;
  elements: number;
  relations: number;
  kinds: Record<string, number>;
  skipped: string[];
  skippedTotal: number;
  created: number;
  updated: number;
  unchanged: number;
  diff: DiffEntry[];
};
const KIND: Record<string, string> = {
  location: 'Lokasi',
  network_segment: 'Segmen jaringan',
  network_device: 'Perangkat jaringan',
  server: 'Server fisik',
  storage: 'Storage',
  virtual_machine: 'VM',
  platform: 'Platform',
  software: 'Aplikasi',
};
const FIELD: Record<string, string> = {
  kind: 'jenis',
  name: 'nama',
  hostname: 'hostname',
  ipAddress: 'IP',
  environment: 'lingkungan',
  location: 'lokasi',
  os: 'OS',
  osVersion: 'versi',
  status: 'status',
  owner: 'pemilik',
  endOfSupport: 'end of support',
  description: 'deskripsi',
  attributes: 'atribut lain',
};
const show = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? '—'
    : typeof v === 'object'
      ? `${Object.keys(v as object).length} tag`
      : String(v);

/** The change set as a reviewer reads it: new elements, and per changed element what moved. */
function DiffList({ diff, max = 12 }: { diff: DiffEntry[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? diff : diff.slice(0, max);
  if (!diff.length) return <p className="sub tiny">Tidak ada elemen yang berubah.</p>;
  return (
    <>
      <ul className="ta-diff">
        {shown.map((d) => (
          <li key={d.externalId}>
            <span className={`pill ${d.change === 'created' ? 'p-green' : 'p-amber'}`}>
              {d.change === 'created' ? 'baru' : 'berubah'}
            </span>{' '}
            <strong>{d.name}</strong> <span className="sub tiny">{KIND[d.kind] ?? d.kind}</span>
            {d.change === 'updated' && (
              <ul>
                {Object.entries(d.fields).map(([k, [o, n]]) => (
                  <li key={k} className="sub tiny">
                    {FIELD[k] ?? k}: <del>{show(o)}</del> → <ins>{show(n)}</ins>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {diff.length > max && (
        <button type="button" className="btn btn-sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Ringkas' : `Tampilkan semua ${diff.length}`}
        </button>
      )}
    </>
  );
}

/** Choose file + category -> preview (scanned, nothing written) -> submit for review. */
export function TaImport({ categories }: { categories: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [categoryId, setCategoryId] = useState(
    categories.find((c) => /infrastruktur/i.test(c.name))?.id ?? categories[0]?.id ?? '',
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function send(mode: 'preview' | 'submit') {
    if (!file || !categoryId || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    const form = new FormData();
    form.set('file', file);
    form.set('categoryId', categoryId);
    form.set('mode', mode);
    if (mode === 'submit' && preview) form.set('sha256', preview.sha256);
    try {
      const r = await fetch('/api/ta/import', { method: 'POST', body: form });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? 'Impor gagal.');
      if (mode === 'preview') setPreview(body as Preview);
      else {
        setMessage('Diajukan. Model berubah setelah admin lain menyetujui.');
        setPreview(null);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impor gagal.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card card-b ta-import">
      <h2 className="h3">Ajukan impor</h2>
      <div className="ta-import-row">
        <label>
          Berkas
          <input
            className="inp"
            type="file"
            accept=".xmi,.xml,.csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setMessage('');
            }}
          />
        </label>
        <label>
          Kategori
          <select
            className="inp"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPreview(null);
            }}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          type="button"
          disabled={!file || busy}
          onClick={() => void send('preview')}
        >
          <Icon name="eye" size={14} />
          {busy && !preview ? 'Memindai & membaca…' : 'Pratinjau'}
        </button>
        <a className="btn" href="/api/ta/template">
          <Icon name="download" size={14} />
          Template CSV
        </a>
      </div>
      <p className="sub tiny">
        XMI dari Sparx (<em>Publish › Export XMI 2.1</em>) atau template CSV. Stereotype ArchiMate
        dan tagged value <code>hostname</code>, <code>ip_address</code>, <code>environment</code>,{' '}
        <code>os</code>, <code>location</code>, <code>owner</code>, <code>end_of_support</code>{' '}
        dibaca otomatis.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="ta-ok">
          <Icon name="check-c" size={15} /> {message}
        </p>
      )}
      {preview && (
        <div className="ta-preview">
          <h3 className="h3">Pratinjau · {preview.format.toUpperCase()} · lolos pemindaian</h3>
          <div className="ta-preview-nums">
            <span>
              <strong>{preview.elements}</strong> elemen
            </span>
            <span>
              <strong>{preview.relations}</strong> relasi
            </span>
            <span className="pill p-green">{preview.created} baru</span>
            <span className="pill p-amber">{preview.updated} berubah</span>
            <span className="pill p-grey">{preview.unchanged} sama</span>
          </div>
          <p className="sub tiny">
            {Object.entries(preview.kinds)
              .map(([k, n]) => `${KIND[k] ?? k} ${n}`)
              .join(' · ')}
          </p>
          <DiffList diff={preview.diff} />
          {preview.skippedTotal > 0 && (
            <details className="ta-skipped">
              <summary>{preview.skippedTotal} catatan: dilewati atau diperbaiki</summary>
              <ul>
                {preview.skipped.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </details>
          )}
          <button
            className="btn btn-p"
            type="button"
            disabled={busy || preview.created + preview.updated === 0}
            onClick={() => void send('submit')}
          >
            {busy ? 'Mengajukan…' : 'Ajukan untuk review'}
          </button>
          {preview.created + preview.updated === 0 && (
            <span className="sub tiny"> Tidak ada perubahan untuk diajukan.</span>
          )}
        </div>
      )}
    </section>
  );
}

type QueueItem = {
  id: string;
  filename: string;
  format: string;
  categoryName: string;
  importedAt: string;
  importedBy: string | null;
  importedById: string;
  summary: { elements?: number; skipped: string[] };
  diff: DiffEntry[];
};
/** Pending proposals: others' to approve or reject, one's own to withdraw. */
export function TaReviewQueue({ items, actorId }: { items: QueueItem[]; actorId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<Record<string, string>>({});
  async function decide(id: string, decision: 'approve' | 'reject' | 'withdraw') {
    setBusy(id + decision);
    setError((e) => ({ ...e, [id]: '' }));
    try {
      const r = await fetch(`/api/ta/import/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, ...(notes[id] ? { note: notes[id] } : {}) }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? 'Tidak dapat diproses.');
      router.refresh();
    } catch (e) {
      setError((x) => ({ ...x, [id]: e instanceof Error ? e.message : 'Tidak dapat diproses.' }));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="card card-b mt20" aria-labelledby="ta-queue-title">
      <h2 className="h3" id="ta-queue-title">
        Menunggu review{' '}
        <span className={`pill ${items.length ? 'p-amber' : 'p-grey'}`}>{items.length}</span>
      </h2>
      {!items.length && <p className="sub">Tidak ada impor yang menunggu.</p>}
      {items.map((i) => {
        const mine = i.importedById === actorId;
        return (
          <article key={i.id} className="ta-queue-item">
            <header>
              <a href={`/api/ta/import/${i.id}/original`}>{i.filename}</a>{' '}
              <span className="pill p-grey">{i.format.toUpperCase()}</span>
              <span className="sub tiny">
                {' '}
                · {i.categoryName} · diajukan {i.importedBy ?? '—'}, {i.importedAt}
              </span>
            </header>
            <DiffList diff={i.diff} max={8} />
            {mine ? (
              <div className="ta-queue-actions">
                <span className="sub tiny">Pengajuan Anda — disetujui oleh admin lain.</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() => void decide(i.id, 'withdraw')}
                >
                  Tarik pengajuan
                </button>
              </div>
            ) : (
              <div className="ta-queue-actions">
                <input
                  className="inp"
                  placeholder="Catatan (wajib bila menolak)"
                  aria-label={`Catatan untuk ${i.filename}`}
                  value={notes[i.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [i.id]: e.target.value }))}
                  maxLength={2000}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!!busy}
                  onClick={() => void decide(i.id, 'reject')}
                >
                  Tolak
                </button>
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={!!busy}
                  onClick={() => void decide(i.id, 'approve')}
                >
                  {busy === i.id + 'approve' ? 'Menerapkan…' : 'Setujui & terapkan'}
                </button>
              </div>
            )}
            {error[i.id] && (
              <p role="alert" className="inline-error">
                {error[i.id]}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
