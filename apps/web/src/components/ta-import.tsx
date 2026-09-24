'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

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

/** Choose file + category -> preview (nothing written) -> apply the same file. */
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
  async function send(mode: 'preview' | 'apply') {
    if (!file || !categoryId || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    const form = new FormData();
    form.set('file', file);
    form.set('categoryId', categoryId);
    form.set('mode', mode);
    if (mode === 'apply' && preview) form.set('sha256', preview.sha256);
    try {
      const r = await fetch('/api/ta/import', { method: 'POST', body: form });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? 'Impor gagal.');
      if (mode === 'preview') setPreview(body as Preview);
      else {
        const s = body.summary;
        setMessage(
          `Diterapkan: ${s.created} baru, ${s.updated} berubah, ${s.unchanged} sama, ${s.relations} relasi.`,
        );
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
          {busy && !preview ? 'Membaca…' : 'Pratinjau'}
        </button>
        <a className="btn" href="/api/ta/template">
          <Icon name="download" size={14} />
          Template CSV
        </a>
      </div>
      <p className="sub tiny">
        Pemetaan: Node → server/VM, Device → perangkat jaringan, ExecutionEnvironment/SystemSoftware
        → platform, Component/ApplicationComponent → aplikasi, stereotype ArchiMate dipakai lebih
        dulu. Tagged value <code>hostname</code>, <code>ip_address</code>, <code>environment</code>,{' '}
        <code>os</code>, <code>os_version</code>, <code>location</code>, <code>owner</code>,{' '}
        <code>end_of_support</code> dibaca sebagai atribut; tag lain disimpan apa adanya.
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
          <h3 className="h3">Pratinjau · {preview.format.toUpperCase()}</h3>
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
            disabled={busy}
            onClick={() => void send('apply')}
          >
            {busy ? 'Menerapkan…' : 'Terapkan impor'}
          </button>
        </div>
      )}
    </section>
  );
}
