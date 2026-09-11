'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

export interface RequiredReadingItem {
  id: string;
  href: string;
  documentTitle: string;
  categoryName: string;
  note: string;
  /** Decided on the server, so rendering stays pure. */
  overdue: boolean;
  dueLabel: string | null;
  acknowledgedLabel: string | null;
  versionId: string;
}

/**
 * Required reading (V1 S06). The list only ever contains documents this person can
 * already read -- a requirement is scoped to a category and filtered by RLS -- so it
 * never reveals anything. Acknowledging records the version that was actually current.
 */
export function RequiredReadingList({ items }: { items: RequiredReadingItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function acknowledge(item: RequiredReadingItem) {
    setBusy(item.id);
    setError('');
    try {
      const r = await fetch(`/api/required-reading/${item.id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: item.versionId }),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Gagal mencatat.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(null);
    }
  }

  const open = items.filter((i) => !i.acknowledgedLabel);
  const done = items.filter((i) => i.acknowledgedLabel);

  return (
    <div className="card-b">
      {open.length === 0 && (
        <p className="sub">Tidak ada bacaan wajib yang belum Anda konfirmasi.</p>
      )}
      <ul className="personal-list">
        {open.map((i) => (
          <li key={i.id}>
            <div>
              <Link href={i.href} prefetch={false} className="document-title">
                {i.documentTitle}
              </Link>{' '}
              <span className="sub tiny">· {i.categoryName}</span>
              {i.dueLabel && (
                <span className={`tag${i.overdue ? ' c-warn' : ''}`} style={{ marginLeft: 8 }}>
                  {i.overdue ? 'Lewat tenggat ' : 'Tenggat '}
                  {i.dueLabel}
                </span>
              )}
            </div>
            <p className="sub">{i.note}</p>
            <div className="row">
              <Link href={i.href} prefetch={false} className="btn btn-sm">
                <Icon name="book" size={14} /> Baca
              </Link>
              <button
                type="button"
                className="btn btn-p btn-sm"
                disabled={busy === i.id}
                onClick={() => void acknowledge(i)}
              >
                <Icon name="check" size={14} />
                {busy === i.id ? 'Mencatat…' : 'Sudah saya baca'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <details>
          <summary className="sub">Sudah dikonfirmasi ({done.length})</summary>
          <ul className="personal-list">
            {done.map((i) => (
              <li key={i.id}>
                <Link href={i.href} prefetch={false} className="document-title">
                  {i.documentTitle}
                </Link>{' '}
                <span className="sub tiny">
                  · dikonfirmasi {i.acknowledgedLabel}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="sub tiny">
        Konfirmasi adalah pernyataan Anda telah membaca versi yang berlaku saat itu; bila dokumen
        direvisi, admin dapat memintanya kembali.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
