'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  TaxonomyCategory,
  TaxonomyLabel,
  TaxonomyMeta,
  TaxonomySuggestions,
} from '@intradocs/db/taxonomy';
import { Icon } from './icon';
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
  meta,
  suggestions,
}: {
  categories: TaxonomyCategory[];
  labels: TaxonomyLabel[];
  meta: TaxonomyMeta;
  suggestions: TaxonomySuggestions;
}) {
  const router = useRouter();
  const [category, setCategory] = useState(empty),
    [tighten, setTighten] = useState(false);
  // Forms open on demand (mockup S07: "+ Kategori Baru", "+ Label baru"); the tree and
  // the chips are what the page is about.
  const [categoryForm, setCategoryForm] = useState(false),
    [labelForm, setLabelForm] = useState(false);
  // Forms open below the tree/list; bring them into view so a click on "+ Kategori baru"
  // at the top never lands on an unchanged screen.
  const reveal = (selector: string) =>
    requestAnimationFrame(() =>
      document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  const openCategory = (c: TaxonomyCategory) => {
    setCategory(c);
    setTighten(false);
    setCategoryForm(true);
    reveal('.taxonomy-form-category');
  };
  const openLabel = (l: TaxonomyLabel) => {
    setLabel(l);
    setLabelForm(true);
    reveal('.taxonomy-form-label');
  };
  const [dragging, setDragging] = useState<string | null>(null),
    [dropTarget, setDropTarget] = useState<string | null>(null);
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
      setCategoryForm(false);
      setLabel({ ...label, id: '', name: '', revision: 0 });
      setLabelForm(false);
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
  /**
   * Drag a category onto a sibling to take its place. Ordering only: a parent change
   * goes through the form, because the server refuses to move a category that already
   * holds documents. Positions of the affected siblings are rewritten 10 apart so the
   * next drop has room without renumbering everything.
   */
  async function reorder(sourceId: string, targetId: string) {
    const source = categories.find((c) => c.id === sourceId),
      target = categories.find((c) => c.id === targetId);
    if (!source || !target || source.id === target.id || source.parentId !== target.parentId)
      return;
    const siblings = categories
      .filter((c) => c.parentId === source.parentId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const movingDown = siblings.indexOf(source) < siblings.indexOf(target);
    const without = siblings.filter((c) => c.id !== source.id);
    const at = without.findIndex((c) => c.id === target.id) + (movingDown ? 1 : 0);
    const ordered = [...without.slice(0, at), source, ...without.slice(at)];
    setBusy(true);
    setError('');
    try {
      for (const [i, c] of ordered.entries()) {
        const position = (i + 1) * 10;
        if (c.position === position) continue;
        const r = await fetch('/api/taxonomy/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...c, position, confirmTightening: false }),
        });
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Gagal.');
      }
      setMessage('Urutan disimpan dan diaudit.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="taxonomy-layout">
        <section className="card">
          <div className="card-h">
            <Icon name="folder" size={17} />
            <h2 className="h3">Struktur kategori</h2>
            <span className="sub tiny ml-auto">Seret atau ↑↓ untuk mengubah urutan</span>
            <button className="btn btn-sm btn-p" onClick={() => openCategory(empty)}>
              <Icon name="plus" size={14} /> Kategori baru
            </button>
          </div>
          <ul className="taxonomy-tree">
            {categories.map((c) => (
              <li
                key={c.id}
                style={{ paddingLeft: 16 + depth(c) * 16 }}
                draggable={!busy}
                className={`${dragging === c.id ? 'dragging' : ''} ${dropTarget === c.id ? 'drop-target' : ''}`}
                onDragStart={(e) => {
                  setDragging(c.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                }}
                onDragOver={(e) => {
                  const source = categories.find((x) => x.id === dragging);
                  if (!source || source.id === c.id || source.parentId !== c.parentId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropTarget !== c.id) setDropTarget(c.id);
                }}
                onDragLeave={() => {
                  if (dropTarget === c.id) setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const source = e.dataTransfer.getData('text/plain') || dragging;
                  setDragging(null);
                  setDropTarget(null);
                  if (source) void reorder(source, c.id);
                }}
              >
                <span className="drag-handle" aria-hidden="true">
                  <Icon name="more" size={14} />
                </span>
                {/* Keyboard and screen-reader path for the same reorder; drag is a shortcut. */}
                <span className="order-buttons">
                  {(() => {
                    const siblings = categories
                      .filter((x) => x.parentId === c.parentId)
                      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
                    const at = siblings.findIndex((x) => x.id === c.id);
                    const up = siblings[at - 1],
                      down = siblings[at + 1];
                    return (
                      <>
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={`Naikkan ${c.name}`}
                          disabled={busy || !up}
                          onClick={() => up && void reorder(c.id, up.id)}
                        >
                          <Icon name="up" size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={`Turunkan ${c.name}`}
                          disabled={busy || !down}
                          onClick={() => down && void reorder(c.id, down.id)}
                        >
                          <Icon name="down" size={12} />
                        </button>
                      </>
                    );
                  })()}
                </span>
                <span className={`cat-ic tone-${meta.categories[c.id]?.color ?? 'blue'}`}>
                  <Icon name={meta.categories[c.id]?.icon || 'folder'} size={15} />
                </span>
                <button className="taxonomy-select" onClick={() => openCategory(c)}>
                  <strong>{c.name}</strong>
                  <span className="sub">
                    {CLASSIFICATION_LABELS[c.minimumClassification as Classification]} ·{' '}
                    {c.approvalSteps} tahap · review {c.reviewDays} hari
                  </span>
                </button>
                <span className="taxonomy-meta">
                  <span className="pill p-grey">{meta.categories[c.id]?.documents ?? 0} dok</span>
                  {(meta.categories[c.id]?.children ?? 0) > 0 && (
                    <span className="pill p-blue">
                      {meta.categories[c.id]!.children} sub-kategori
                    </span>
                  )}
                  {c.minimumClassification !== 'internal' &&
                    c.minimumClassification !== 'public' && (
                      <span className="pill p-red">
                        <Icon name="lock" size={11} /> Akses terbatas
                      </span>
                    )}
                </span>
              </li>
            ))}
          </ul>
          {categoryForm && (
            <form
              className="card-b workflow-fields taxonomy-form taxonomy-form-category"
              onSubmit={(e) => {
                e.preventDefault();
                void save('/api/taxonomy/categories', {
                  ...category,
                  id: category.id || null,
                  confirmTightening: tighten,
                });
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>{category.id ? `Edit kategori: ${category.name}` : 'Kategori baru'}</h3>
                <button type="button" className="btn btn-sm" onClick={() => setCategoryForm(false)}>
                  Tutup
                </button>
              </div>
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
                      onChange={(e) =>
                        setCategory({ ...category, position: Number(e.target.value) })
                      }
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
          )}
          {categoryForm && category.id && (
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
            <Icon name="tag" size={17} style={{ color: 'var(--violet)' }} />
            <h2 className="h3">Label</h2>
            <span className="sub tiny">{labels.length} label</span>
            <a className="btn btn-sm ml-auto" href="/api/taxonomy/export">
              <Icon name="download" size={14} />
              Ekspor taksonomi
            </a>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => openLabel({ ...label, id: '', name: '', revision: 0 })}
            >
              <Icon name="plus" size={14} /> Label baru
            </button>
          </div>
          <div className="card-b">
            <TaxonomyHygiene
              suggestions={suggestions}
              labels={labels}
              busy={busy}
              onMerge={(source, target, revision) =>
                void save('/api/taxonomy/merge', { source, target, revision })
              }
              onRemove={(l) => void save('/api/taxonomy/labels', { ...l, remove: true })}
            />
            {/* Labels grouped under their category: the same name can exist in two
                categories (a "Kritikal" for security and one for data), so a flat list
                showed duplicates with no way to tell them apart. */}
            <div className="label-groups">
              {categories
                .filter((c) => labels.some((l) => l.categoryId === c.id))
                .map((c) => (
                  <div className="label-group" key={c.id}>
                    <div className="label-group-h">
                      <i
                        className={`category-dot tone-${meta.categories[c.id]?.color ?? 'blue'}`}
                      />
                      {c.name}
                      <span className="sub tiny">
                        {labels.filter((l) => l.categoryId === c.id).length} label
                      </span>
                    </div>
                    <div className="label-list">
                      {labels
                        .filter((l) => l.categoryId === c.id)
                        .map((l) => (
                          <button
                            className={`tag label-chip tone-${l.color} ${label.id === l.id ? 'tag-on' : ''}`}
                            key={l.id}
                            onClick={() => openLabel(l)}
                            title={`${l.name} · ${c.name}`}
                          >
                            <i className="category-dot" />
                            {l.name}
                            <span className="n">{meta.labels[l.id]?.usedBy ?? 0}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              {labels.some((l) => !categories.some((c) => c.id === l.categoryId)) && (
                <div className="label-group">
                  <div className="label-group-h">Lainnya</div>
                  <div className="label-list">
                    {labels
                      .filter((l) => !categories.some((c) => c.id === l.categoryId))
                      .map((l) => (
                        <button
                          className={`tag label-chip tone-${l.color} ${label.id === l.id ? 'tag-on' : ''}`}
                          key={l.id}
                          onClick={() => openLabel(l)}
                        >
                          <i className="category-dot" />
                          {l.name}
                          <span className="n">{meta.labels[l.id]?.usedBy ?? 0}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
            {labelForm && (
              <form
                className="workflow-fields taxonomy-form taxonomy-form-label"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save('/api/taxonomy/labels', {
                    ...label,
                    id: label.id || null,
                    remove: false,
                  });
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3>{label.id ? `Edit label: ${label.name}` : 'Label baru'}</h3>
                  <button type="button" className="btn btn-sm" onClick={() => setLabelForm(false)}>
                    Tutup
                  </button>
                </div>
                {label.id && (
                  <p className="sub tiny">
                    Dipakai {meta.labels[label.id]?.usedBy ?? 0} versi aktif di{' '}
                    {categories.find((c) => c.id === label.categoryId)?.name}.
                  </p>
                )}
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
                  </div>
                </fieldset>
              </form>
            )}
            {labelForm && label.id && (
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
              Label yang sudah dipakai dokumen tidak bisa diganti nama atau dihapus; buat label baru
              sebagai gantinya.
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

/**
 * "Saran perapian taksonomi": computed on the server from names and usage, applied only
 * through the same merge and delete calls a person would make by hand. Merging keeps the
 * merged name as an alias (V1 S07), so nothing a document carries is lost.
 */
function TaxonomyHygiene({
  suggestions,
  labels,
  busy,
  onMerge,
  onRemove,
}: {
  suggestions: TaxonomySuggestions;
  labels: TaxonomyLabel[];
  busy: boolean;
  onMerge: (source: string, target: string, revision: number) => void;
  onRemove: (label: TaxonomyLabel) => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const duplicates = suggestions.duplicates.filter((d) => !dismissed.has(`${d.a.id}:${d.b.id}`));
  const unused = suggestions.unused.filter((u) => !dismissed.has(u.id));
  if (duplicates.length === 0 && unused.length === 0) return null;
  const dismiss = (key: string) => setDismissed((set) => new Set([...set, key]));
  const revisionOf = (labelId: string) => labels.find((l) => l.id === labelId)?.revision ?? 0;
  return (
    <section className="hygiene" aria-label="Saran perapian taksonomi">
      <div className="hygiene-h">
        <Icon name="spark" size={15} />
        <strong>Saran perapian taksonomi</strong>
        <span className="sub tiny">
          Dihitung dari nama dan pemakaian label; tidak ada yang berubah sebelum Anda menekan
          tombolnya.
        </span>
      </div>
      <ul className="hygiene-list">
        {duplicates.map((d) => {
          const key = `${d.a.id}:${d.b.id}`;
          // Merge INTO the more-used label; the other becomes its alias.
          const [keep, fold] = d.a.usedBy >= d.b.usedBy ? [d.a, d.b] : [d.b, d.a];
          return (
            <li key={key}>
              <div>
                Label <span className="tag">{d.a.name}</span> dan{' '}
                <span className="tag">{d.b.name}</span> di {d.categoryName}{' '}
                {d.reason === 'name'
                  ? `namanya mirip ${Math.round(d.nameSimilarity * 100)}%`
                  : `dipakai bersama pada ${Math.round(d.usageOverlap * 100)}% versi`}
                {d.reason === 'name' && d.usageOverlap > 0
                  ? ` dan tumpang tindih pemakaian ${Math.round(d.usageOverlap * 100)}%`
                  : ''}
                {' — pertimbangkan penggabungan.'}
              </div>
              <div className="reader-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-p"
                  disabled={busy}
                  onClick={() => onMerge(fold.id, keep.id, revisionOf(fold.id))}
                >
                  Gabungkan “{fold.name}” → “{keep.name}”
                </button>
                <button type="button" className="btn btn-sm" onClick={() => dismiss(key)}>
                  Abaikan
                </button>
              </div>
            </li>
          );
        })}
        {unused.length > 0 && (
          <li>
            <div>
              {unused.length} label tidak dipakai versi aktif mana pun:{' '}
              {unused.map((u) => (
                <span className="tag" key={u.id}>
                  {u.name} · {u.categoryName}
                  <button
                    type="button"
                    className="tag-x"
                    aria-label={`Hapus label ${u.name}`}
                    disabled={busy}
                    onClick={() =>
                      onRemove({
                        id: u.id,
                        categoryId: u.categoryId,
                        name: u.name,
                        color: labels.find((l) => l.id === u.id)?.color ?? 'grey',
                        revision: revisionOf(u.id),
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="reader-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => unused.forEach((u) => dismiss(u.id))}
              >
                Abaikan
              </button>
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}
