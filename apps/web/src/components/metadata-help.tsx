'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Icon } from './icon';

interface Help {
  labels: string[];
  categories: Array<{ id: string; name: string; score: number }>;
  similar: Array<{ documentId: string; title: string; categoryName: string; href: string }>;
  aiOn: boolean;
}

/**
 * "Bantuan metadata" on the upload form (mockup S05), the safe version: the draft stays
 * private, one bounded excerpt is used as a retrieval question to find published
 * look-alikes, and label/category hints are lexical. Every suggestion is a button the
 * person presses -- nothing is applied by itself.
 */
export function MetadataHelp({
  title,
  excerpt,
  categoryId,
  currentLabels,
  onPickCategory,
  onAddLabel,
}: {
  title: string;
  excerpt: string;
  categoryId: string;
  currentLabels: string[];
  onPickCategory: (id: string) => void;
  onAddLabel: (name: string) => void;
}) {
  const [help, setHelp] = useState<Help | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/uploads/metadata-help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, excerpt, categoryId: categoryId || null }),
        cache: 'no-store',
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(
          body &&
            typeof body === 'object' &&
            typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Permintaan gagal.',
        );
        return;
      }
      setHelp(body as Help);
    } catch {
      setError('Tidak dapat menghubungi layanan lokal.');
    } finally {
      setPending(false);
    }
  }

  const newLabels = help?.labels.filter((l) => !currentLabels.includes(l)) ?? [];
  return (
    <section className="metadata-help" aria-label="Bantuan metadata">
      <div className="hygiene-h">
        <Icon name="spark" size={15} />
        <strong>Bantuan metadata</strong>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={pending}>
          {pending ? 'Memeriksa…' : help ? 'Periksa ulang' : 'Periksa'}
        </button>
      </div>
      <p className="sub tiny">
        Draft tidak dikirim ke mana pun: label dan kategori dicocokkan secara lokal dari teksnya,
        dan cuplikan awal dipakai sebagai pertanyaan pencarian untuk menemukan dokumen terbit yang
        mirip. Semua hanya usulan.
      </p>
      {error && (
        <div className="callout c-warn" role="alert">
          <Icon name="alert" size={16} />
          <div>{error}</div>
        </div>
      )}
      {help && (
        <div className="metadata-help-body">
          {help.similar.length > 0 ? (
            <div>
              <strong className="tiny">
                Dokumen terbit yang mirip — periksa sebelum mengunggah:
              </strong>
              <ul className="insight-questions">
                {help.similar.map((d) => (
                  <li key={d.documentId}>
                    <Link href={d.href} prefetch={false} target="_blank">
                      <Icon name="file" size={14} />
                      {d.title}
                      <span className="sub tiny"> · {d.categoryName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="sub tiny">
              {help.aiOn
                ? 'Tidak ada dokumen terbit yang cukup mirip dalam cakupan akses Anda.'
                : 'Pemeriksaan duplikat semantik membutuhkan AI Assistant aktif; hanya label dan kategori yang dicocokkan.'}
            </p>
          )}
          {help.categories.length > 0 && (
            <div>
              <strong className="tiny">Kategori yang kosakatanya muncul di teks:</strong>
              <div className="reader-actions">
                {help.categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`btn btn-sm${c.id === categoryId ? ' btn-p' : ''}`}
                    onClick={() => onPickCategory(c.id)}
                  >
                    {c.name} <span className="sub tiny">({c.score})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {categoryId &&
            (newLabels.length > 0 ? (
              <div>
                <strong className="tiny">Label kategori ini yang disebut dalam teks:</strong>
                <div className="reader-actions">
                  {newLabels.map((l) => (
                    <button
                      key={l}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onAddLabel(l)}
                    >
                      + {l}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="sub tiny">
                Tidak ada label kategori ini yang belum dipakai dan disebut di teks.
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
