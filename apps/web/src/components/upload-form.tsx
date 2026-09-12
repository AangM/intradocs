'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Icon } from './icon';
import { MetadataHelp } from './metadata-help';
import { CLASSIFICATIONS, CLASSIFICATION_LABELS, type Classification } from '@intradocs/core';
type Category = { id: string; name: string; allowed: boolean; minimumClassification: string };
type Result = { documentId: string; versionId: string; slug: string; reused: boolean };
type ScannerState = { ready: boolean; message: string };
export type RevisionInput = {
  documentId: string;
  baseVersionId: string;
  title: string;
  summary: string;
  categoryId: string;
  labels: string[];
  classification: Classification;
};
const steps = ['Pilih sumber', 'Metadata', 'Proses & simpan', 'Tinjau hasil'];
export function UploadForm({
  categories,
  ownerName,
  maxFileBytes,
  initialScanner,
  revision,
  initialTitle,
}: {
  categories: Category[];
  ownerName: string;
  maxFileBytes: number;
  initialScanner: ScannerState;
  revision?: RevisionInput;
  /** Title seed for a new document, e.g. a knowledge-gap term from the dashboard. */
  initialTitle?: string;
}) {
  const [step, setStep] = useState(1),
    [file, setFile] = useState<File | null>(null),
    [attachments, setAttachments] = useState<File[]>([]),
    [source, setSource] = useState(''),
    [preview, setPreview] = useState('');
  const [title, setTitle] = useState(revision?.title ?? initialTitle ?? ''),
    [summary, setSummary] = useState(revision?.summary ?? ''),
    [categoryId, setCategoryId] = useState(
      revision?.categoryId ?? categories.find((c) => c.allowed)?.id ?? '',
    ),
    [labels, setLabels] = useState(revision?.labels.join(', ') ?? '');
  const [classification, setClassification] = useState<Classification>(
    revision?.classification ?? 'internal',
  );
  const [synthetic, setSynthetic] = useState(false),
    [scanner, setScanner] = useState(initialScanner),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Result | null>(null),
    [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    requestId = useRef<string | null>(null),
    selection = useRef(0),
    controller = useRef<AbortController | null>(null);
  const changed = () => {
    requestId.current = null;
    setError('');
  };
  function checkFile(f: File) {
    if (!/\.(md|txt|pdf|docx|xlsx)$/i.test(f.name))
      throw new Error('Gunakan MD, TXT, PDF bertesks, DOCX, atau XLSX.');
    if (!f.size || f.size > maxFileBytes)
      throw new Error('Setiap berkas harus berisi data dan maksimal 50 MiB.');
  }
  async function choose(files: FileList | null) {
    if (busy || !files?.length) return;
    if (files.length !== 1) {
      setError('Pilih satu berkas utama; tambahkan sumber lain sebagai lampiran.');
      return;
    }
    const f = files[0]!,
      token = ++selection.current;
    changed();
    setFile(null);
    setSource('');
    try {
      checkFile(f);
      let text = '';
      if (/\.(md|txt)$/i.test(f.name) && f.size <= 2 * 1024 * 1024)
        text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
      if (token !== selection.current) return;
      setFile(f);
      setSource(text);
      if (!revision)
        setTitle(
          f.name
            .replace(/\.[^.]+$/, '')
            .replace(/[_-]+/g, ' ')
            .slice(0, 180),
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encoding UTF-8 tidak valid.');
    }
  }
  function chooseAttachments(files: FileList | null) {
    if (!files) return;
    changed();
    try {
      const selected = [...files];
      if (selected.length > 4) throw new Error('Maksimal empat lampiran.');
      selected.forEach(checkFile);
      if (selected.reduce((n, f) => n + f.size, file?.size ?? 0) > 100 * 1024 * 1024)
        throw new Error('Total utama dan lampiran maksimal 100 MiB.');
      setAttachments(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lampiran tidak valid.');
    }
  }
  function validMetadata() {
    if (title.trim().length < 3 || title.length > 180) {
      setError('Judul harus 3–180 karakter.');
      return false;
    }
    if (!categories.some((c) => c.id === categoryId && c.allowed)) {
      setError('Pilih kategori leaf dalam scope Anda.');
      return false;
    }
    const floor =
      categories.find((c) => c.id === categoryId)?.minimumClassification ?? 'confidential';
    if (
      CLASSIFICATIONS.indexOf(classification) < CLASSIFICATIONS.indexOf(floor as Classification)
    ) {
      setError('Klasifikasi tidak boleh lebih rendah dari minimum kategori.');
      return false;
    }
    const list = labels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 8 || list.some((s) => s.length < 3 || s.length > 32)) {
      setError('Maksimal delapan label, masing-masing 3–32 karakter.');
      return false;
    }
    return true;
  }
  async function checkScanner() {
    setChecking(true);
    try {
      const r = await fetch('/api/uploads/scanner', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      setScanner(await r.json());
    } catch {
      setScanner({
        ready: false,
        message: 'Pemindai belum dapat diperiksa. Periksa login dan layanan lokal.',
      });
    } finally {
      setChecking(false);
    }
  }
  async function save() {
    if (busy || !file || !validMetadata()) return;
    if (!synthetic) {
      setError('Konfirmasi penggunaan data sintetis dahulu.');
      return;
    }
    if ([file, ...attachments].reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024) {
      setError('Total berkas maksimal 100 MiB.');
      return;
    }
    setBusy(true);
    setError('');
    requestId.current ??= crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 290000);
    const form = new FormData();
    form.set('file', file);
    for (const a of attachments) form.append('attachments', a);
    form.set('title', title.trim());
    form.set('summary', summary.trim());
    form.set('categoryId', categoryId);
    form.set('classification', classification);
    form.set(
      'labels',
      JSON.stringify(
        labels
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    form.set('synthetic', 'true');
    if (revision) {
      form.set('documentId', revision.documentId);
      form.set('baseVersionId', revision.baseVersionId);
    }
    try {
      const r = await fetch('/api/documents/drafts', {
        method: 'POST',
        body: form,
        headers: { 'Idempotency-Key': requestId.current },
        signal: abort.signal,
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Unggahan gagal.');
      if (!v.documentId || !v.versionId || !v.slug) throw new Error('Respons tidak lengkap.');
      setResult(v);
      setStep(4);
      const md = await fetch(`/api/files/${v.versionId}/markdown`, {
        cache: 'no-store',
        signal: abort.signal,
      });
      if (md.ok) setPreview(await md.text());
      else setError('Draft tersimpan. Buka reader untuk meninjau hasil konversi.');
    } catch (e) {
      setError(
        abort.signal.aborted
          ? 'Permintaan dibatalkan/terputus. Ulangi tanpa mengubah berkas untuk memeriksa hasil sebelumnya.'
          : e instanceof Error
            ? e.message
            : 'Unggahan gagal.',
      );
    } finally {
      clearTimeout(timer);
      setBusy(false);
      controller.current = null;
    }
  }
  return (
    <>
      {revision && (
        <div className="callout c-info">
          <Icon name="layers" />
          <p>
            <strong>Revisi immutable baru.</strong> Versi lama tidak ditimpa. Upload ulang seluruh
            lampiran yang ingin dipertahankan; perubahan membatalkan review versi sebelumnya yang
            belum terpublikasi.
          </p>
        </div>
      )}
      <ol className="steps upload-steps" aria-label="Tahapan unggah">
        {steps.map((label, i) => (
          <li
            className={`step ${step > i + 1 ? 'done' : step === i + 1 ? 'now' : ''}`}
            aria-current={step === i + 1 ? 'step' : undefined}
            key={label}
          >
            <span className="b">{step > i + 1 ? <Icon name="check" size={13} /> : i + 1}</span>
            <span className="l">{label}</span>
          </li>
        ))}
      </ol>
      <div className={`callout ${scanner.ready ? 'c-info' : 'c-warn'} upload-scanner`}>
        <Icon name="shield" />
        <div>
          <strong>{scanner.ready ? 'Pemindai tersedia' : 'Pemindai belum tersedia'}</strong>
          <p>{scanner.message}</p>
          <p className="hint">
            Kesiapan bukan hasil scan. Setiap original dan lampiran dipindai sebelum dikonversi.
            Converter terisolasi diperlukan untuk PDF/Office.
          </p>
        </div>
        <button
          className="btn btn-sm"
          disabled={checking || busy}
          onClick={() => void checkScanner()}
        >
          {checking ? 'Memeriksa…' : 'Periksa ulang'}
        </button>
      </div>
      {error && (
        <p role="alert" className="upload-error">
          {error}
        </p>
      )}
      {step === 1 && (
        <section className="card">
          <div className="card-b">
            <div
              className={`drop ${dragging ? 'upload-dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void choose(e.dataTransfer.files);
              }}
            >
              <div className="ic">
                <Icon name="upload" size={24} />
              </div>
              <h2>Tarik sumber utama ke sini</h2>
              <p className="sub">50 MiB per berkas · 100 MiB total · data sintetis saja</p>
              <div className="fmt">
                {['MD', 'TXT', 'PDF', 'DOCX', 'XLSX'].map((f) => (
                  <span key={f}>{f}</span>
                ))}
              </div>
              <input
                id="source-file"
                ref={input}
                type="file"
                hidden
                aria-label="Berkas utama"
                accept=".md,.txt,.pdf,.docx,.xlsx"
                onChange={(e) => void choose(e.target.files)}
              />
              <button className="btn btn-p" onClick={() => input.current?.click()}>
                Pilih berkas utama
              </button>
            </div>
            {file && (
              <div className="file-row">
                <Icon name="file" />
                <strong>{file.name}</strong>
                <span className="sub">{(file.size / 1024).toFixed(1)} KiB · belum dipindai</span>
              </div>
            )}
            <label className="attachment-picker">
              Lampiran (opsional, maksimal 4)
              <input
                type="file"
                multiple
                accept=".md,.txt,.pdf,.docx,.xlsx"
                onChange={(e) => chooseAttachments(e.target.files)}
              />
            </label>
            {attachments.map((a, i) => (
              <p className="sub" key={i}>
                {i + 1}. {a.name} · {(a.size / 1024).toFixed(1)} KiB
              </p>
            ))}
            <p className="hint">
              Hasil canonical gabungan maksimal 2 MiB. PDF pindai, macro, ZIP, format
              rusak/encrypted, dan hasil yang kehilangan data penting ditolak; tidak ada OCR atau AI
              yang mengarang isinya.
            </p>
            <div className="upload-actions">
              <button className="btn btn-p" disabled={!file} onClick={() => setStep(2)}>
                Lanjut ke metadata <Icon name="arrow-r" size={14} />
              </button>
            </div>
          </div>
        </section>
      )}
      {step === 2 && (
        <section className="card">
          <div className="card-h">
            <Icon name="tag" />
            <h2 className="h3">Metadata & Klasifikasi</h2>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (validMetadata()) setStep(3);
            }}
          >
            <fieldset className="card-b upload-fields">
              <label>
                Judul dokumen
                <input
                  className="inp"
                  minLength={3}
                  maxLength={180}
                  required
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    changed();
                  }}
                />
              </label>
              <label>
                Ringkasan
                <textarea
                  className="inp"
                  rows={3}
                  maxLength={1000}
                  value={summary}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    changed();
                  }}
                />
              </label>
              <div className="grid g2">
                <label>
                  Kategori
                  <select
                    className="inp"
                    required
                    disabled={!!revision}
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      changed();
                    }}
                  >
                    <option value="">Pilih kategori</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id} disabled={!c.allowed}>
                        {c.name}
                        {!c.allowed ? ' — tidak tersedia' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Klasifikasi
                  <select
                    className="inp"
                    disabled={!!revision}
                    value={classification}
                    onChange={(e) => {
                      setClassification(e.target.value as Classification);
                      changed();
                    }}
                  >
                    {CLASSIFICATIONS.map((c) => (
                      <option key={c} value={c}>
                        {CLASSIFICATION_LABELS[c]}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    Minimal sesuai kategori. Terbatas/Rahasia: grant eksplisit dan dua reviewer
                    berbeda; dataset tetap sintetis.
                  </span>
                </label>
              </div>
              <label>
                Label
                <input
                  className="inp"
                  value={labels}
                  maxLength={264}
                  onChange={(e) => {
                    setLabels(e.target.value);
                    changed();
                  }}
                  placeholder="Panduan, Kritikal"
                />
                <span className="hint">
                  Pisahkan dengan koma. Kritikal memerlukan dua reviewer.
                </span>
              </label>
              <label>
                Pemilik
                <input className="inp" value={ownerName} readOnly />
              </label>
              {/* Draft-side help: the file stays here; see MetadataHelp for what travels. */}
              <MetadataHelp
                title={title}
                excerpt={source.slice(0, 20000)}
                categoryId={categoryId}
                currentLabels={labels
                  .split(',')
                  .map((l) => l.trim())
                  .filter(Boolean)}
                onPickCategory={(id) => {
                  if (revision || !categories.find((c) => c.id === id)?.allowed) return;
                  setCategoryId(id);
                  changed();
                }}
                onAddLabel={(name) => {
                  const current = labels
                    .split(',')
                    .map((l) => l.trim())
                    .filter(Boolean);
                  if (current.some((l) => l.toLowerCase() === name.toLowerCase())) return;
                  setLabels([...current, name].join(', '));
                  changed();
                }}
              />
            </fieldset>
            <div className="upload-form-footer">
              <button className="btn" type="button" onClick={() => setStep(1)}>
                Kembali
              </button>
              <button className="btn btn-p">Tinjau sumber</button>
            </div>
          </form>
        </section>
      )}
      {step === 3 && (
        <section className="card">
          <div className="card-h">
            <Icon name="file" />
            <h2 className="h3">Proses sumber menjadi draft privat</h2>
          </div>
          <div className="card-b">
            <h3>{title}</h3>
            <p>
              {file?.name} · {attachments.length} lampiran · {CLASSIFICATION_LABELS[classification]}
            </p>
            {source ? (
              <>
                <p className="hint">
                  Pratinjau lokal literal, bukan hasil scan/konversi. Konfirmasi hasil canonical
                  pada langkah berikutnya sebelum mengajukan.
                </p>
                <pre className="upload-preview" tabIndex={0} aria-label="Pratinjau sumber literal">
                  {source.slice(0, 20000)}
                </pre>
                {source.length > 20000 && (
                  <p className="hint">Pratinjau dipotong pada 20.000 karakter.</p>
                )}
              </>
            ) : (
              <p className="muted-panel">
                Hasil canonical ditampilkan sesudah scan dan konversi server. File kosong atau
                konversi gagal tidak menjadi draft sukses.
              </p>
            )}
            <label className="upload-check">
              <input
                type="checkbox"
                checked={synthetic}
                onChange={(e) => {
                  setSynthetic(e.target.checked);
                  changed();
                }}
                disabled={busy}
              />
              <span>
                Saya menggunakan file contoh tanpa data Telkom, data pribadi, atau credential nyata.
                Ini bukan pemeriksaan DLP otomatis.
              </span>
            </label>
            <p className="hint">
              Original, canonical, provenance, dan seluruh lampiran disimpan immutable dalam satu
              versi privat. Belum dipublikasikan.
            </p>
          </div>
          <div className="upload-form-footer">
            <button className="btn" disabled={busy} onClick={() => setStep(2)}>
              Kembali
            </button>
            <div className="row">
              {busy && (
                <button className="btn" onClick={() => controller.current?.abort()}>
                  Batalkan
                </button>
              )}
              <button
                className="btn btn-p"
                disabled={busy || !synthetic || !scanner.ready}
                onClick={() => void save()}
              >
                {busy ? 'Memindai, mengonversi & menyimpan…' : 'Simpan draft privat'}
              </button>
            </div>
          </div>
          {busy && (
            <p role="status" className="upload-live">
              Proses berlangsung tanpa publikasi. Status ditampilkan tanpa persentase buatan.
            </p>
          )}
        </section>
      )}
      {step === 4 && result && (
        <section className="card">
          <div className="card-b upload-success">
            <Icon name="check-c" size={32} />
            <h2>{result.reused ? 'Draft identik sudah tersedia' : 'Draft privat tersimpan'}</h2>
            <p>
              Bandingkan canonical di bawah dengan original dan lampiran di reader. Pengajuan review
              tetap memerlukan konfirmasi Anda.
            </p>
            <div className="row wrap">
              <Link
                className="btn btn-p"
                href={`/dokumen/${result.documentId}/${result.slug}?version=${result.versionId}`}
              >
                Buka draft & ajukan review
              </Link>
              <Link className="btn" href="/katalog?status=mine">
                Draft saya
              </Link>
            </div>
          </div>
          {preview && (
            <div className="card-b">
              <h3>Hasil canonical gabungan</h3>
              <pre className="upload-preview" tabIndex={0}>
                {preview.slice(0, 20000)}
              </pre>
              {preview.length > 20000 && (
                <p className="hint">
                  Pratinjau dipotong pada 20.000 karakter. Reader menampilkan seluruh isi.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
