'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TaxonomyCategory, TaxonomyLabel } from '@intradocs/db/taxonomy';
import { CLASSIFICATION_LABELS, type Classification } from '@intradocs/core';
const empty: TaxonomyCategory = {
  id: '',
  parentId: null,
  name: '',
  description: '',
  minimumClassification: 'internal',
  approvalSteps: 1,
  reviewDays: 180,
  position: 0,
  revision: 0,
};
export function TaxonomyEditor({
  categories,
  labels,
}: {
  categories: TaxonomyCategory[];
  labels: TaxonomyLabel[];
}) {
  const router = useRouter();
  const [category, setCategory] = useState(empty),
    [tighten, setTighten] = useState(false);
  const [label, setLabel] = useState<TaxonomyLabel>({
    id: '',
    categoryId: categories[0]?.id ?? '',
    name: '',
    color: 'blue',
    revision: 0,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function save(url: string, body: unknown, method = 'POST') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Tidak dapat menyimpan.');
      setMessage('Perubahan disimpan dan diaudit.');
      setCategory(empty);
      setTighten(false);
      setLabel({ ...label, id: '', name: '', revision: 0 });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }
  function depth(c: TaxonomyCategory): number {
    let n = 0,
      current = c;
    const seen = new Set([c.id]);
    while (current.parentId) {
      const parent = categories.find((x) => x.id === current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      n++;
      current = parent;
    }
    return n;
  }
  return (
    <>
      <div className="taxonomy-layout">
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Pohon Kategori</h2>
            <button
              className="btn btn-sm"
              onClick={() => {
                setCategory(empty);
                setTighten(false);
              }}
            >
              Tambah kategori
            </button>
          </div>
          <ul className="taxonomy-tree">
            {categories.map((c) => (
              <li key={c.id} style={{ paddingLeft: 16 + depth(c) * 16 }}>
                <button
                  className="taxonomy-select"
                  onClick={() => {
                    setCategory(c);
                    setTighten(false);
                  }}
                >
                  <strong>{c.name}</strong>
                  <span className="sub">
                    {CLASSIFICATION_LABELS[c.minimumClassification as Classification]} ·{' '}
                    {c.approvalSteps} tahap · review {c.reviewDays} hari
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="card-b workflow-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void save('/api/taxonomy/categories', {
                ...category,
                id: category.id || null,
                confirmTightening: tighten,
              });
            }}
          >
            <h3>{category.id ? 'Edit kategori' : 'Kategori baru'}</h3>
            <fieldset disabled={busy} className="workflow-fields">
              <label>
                Nama kategori
                <input
                  className="inp"
                  required
                  minLength={3}
                  maxLength={100}
                  value={category.name}
                  onChange={(e) => setCategory({ ...category, name: e.target.value })}
                />
              </label>
              <label>
                Induk kategori
                <select
                  className="inp"
                  value={category.parentId ?? ''}
                  onChange={(e) => setCategory({ ...category, parentId: e.target.value || null })}
                >
                  <option value="">Tanpa induk (scope global)</option>
                  {categories
                    .filter((c) => c.id !== category.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Deskripsi
                <textarea
                  className="inp"
                  maxLength={500}
                  value={category.description}
                  onChange={(e) => setCategory({ ...category, description: e.target.value })}
                />
              </label>
              <div className="grid g2">
                <label>
                  Klasifikasi minimum
                  <select
                    className="inp"
                    value={category.minimumClassification}
                    onChange={(e) =>
                      setCategory({ ...category, minimumClassification: e.target.value })
                    }
                  >
                    {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tahap persetujuan
                  <select
                    className="inp"
                    value={category.approvalSteps}
                    onChange={(e) =>
                      setCategory({ ...category, approvalSteps: Number(e.target.value) })
                    }
                  >
                    <option value={1}>Satu tahap</option>
                    <option value={2}>Dua tahap</option>
                  </select>
                </label>
                <label>
                  Review berkala (hari)
                  <input
                    type="number"
                    className="inp"
                    min={1}
                    max={3650}
                    value={category.reviewDays}
                    onChange={(e) =>
                      setCategory({ ...category, reviewDays: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Urutan
                  <input
                    type="number"
                    className="inp"
                    min={0}
                    max={10000}
                    value={category.position}
                    onChange={(e) => setCategory({ ...category, position: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label className="upload-check">
                <input
                  type="checkbox"
                  checked={tighten}
                  onChange={(e) => setTighten(e.target.checked)}
                />
                <span>
                  Saya mengonfirmasi pengetatan akses/approval. Pembaca yang tidak lagi berizin
                  langsung kehilangan akses.
                </span>
              </label>
              <button className="btn btn-p">Simpan kategori</button>
            </fieldset>
          </form>
          {category.id && (
            <details className="card-b">
              <summary>Hapus kategori kosong</summary>
              <p>Ditolak bila masih memiliki anak, dokumen, label, versi, atau upload.</p>
              <button
                className="btn btn-r"
                disabled={busy}
                onClick={() =>
                  void save(
                    '/api/taxonomy/categories',
                    { id: category.id, revision: category.revision },
                    'DELETE',
                  )
                }
              >
                Konfirmasi hapus kategori
              </button>
            </details>
          )}
        </section>
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Label</h2>
          </div>
          <div className="card-b">
            <div className="label-list">
              {labels.map((l) => (
                <button className={`tag tone-${l.color}`} key={l.id} onClick={() => setLabel(l)}>
                  {l.name} · {categories.find((c) => c.id === l.categoryId)?.name}
                </button>
              ))}
            </div>
            <form
              className="workflow-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void save('/api/taxonomy/labels', {
                  ...label,
                  id: label.id || null,
                  remove: false,
                });
              }}
            >
              <h3>{label.id ? 'Edit label' : 'Label baru'}</h3>
              <fieldset disabled={busy} className="workflow-fields">
                <label>
                  Kategori label
                  <select
                    className="inp"
                    required
                    disabled={!!label.id}
                    value={label.categoryId}
                    onChange={(e) => setLabel({ ...label, categoryId: e.target.value })}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nama label
                  <input
                    className="inp"
                    required
                    minLength={3}
                    maxLength={32}
                    value={label.name}
                    onChange={(e) => setLabel({ ...label, name: e.target.value })}
                  />
                </label>
                <label>
                  Warna
                  <select
                    className="inp"
                    value={label.color}
                    onChange={(e) => setLabel({ ...label, color: e.target.value })}
                  >
                    {['blue', 'green', 'amber', 'red', 'violet', 'grey'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <div className="row wrap">
                  <button className="btn btn-p">Simpan label</button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setLabel({ ...label, id: '', name: '', revision: 0 })}
                  >
                    Label baru
                  </button>
                </div>
              </fieldset>
            </form>
            {label.id && (
              <details>
                <summary>Hapus label tidak terpakai</summary>
                <button
                  className="btn btn-r"
                  disabled={busy}
                  onClick={() => void save('/api/taxonomy/labels', { ...label, remove: true })}
                >
                  Konfirmasi hapus label
                </button>
              </details>
            )}
            <p className="hint">
              Label yang digunakan versi immutable tidak boleh diubah namanya atau dihapus. Buat
              label baru untuk penggantian.
            </p>
          </div>
        </section>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
