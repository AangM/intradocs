'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';
import { toast } from './toast';

async function post(url: string) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Gagal menyimpan.');
}

/** One notification: a tick to mark it read; read ones say so quietly. */
export function NotificationRead({ id, read }: { id: string; read: boolean }) {
  const router = useRouter(),
    [busy, setBusy] = useState(false);
  async function mark() {
    setBusy(true);
    try {
      await post(`/api/notifications/${id}`);
      toast('Ditandai dibaca');
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Gagal menyimpan.', 'error');
    } finally {
      setBusy(false);
    }
  }
  if (read) return <span className="nt-read">Dibaca</span>;
  return (
    <button
      type="button"
      className="nt-mark"
      disabled={busy}
      onClick={() => void mark()}
      aria-label="Tandai dibaca"
      title="Tandai dibaca"
    >
      <Icon name="check" size={15} />
    </button>
  );
}

/** Every unread notification of the signed-in person at once. */
export function MarkAllRead() {
  const router = useRouter(),
    [busy, setBusy] = useState(false);
  async function markAll() {
    setBusy(true);
    try {
      await post('/api/notifications');
      toast('Semua notifikasi ditandai dibaca');
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Gagal menyimpan.', 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void markAll()}>
      <Icon name="check" size={14} />
      {busy ? 'Menandai…' : 'Tandai semua dibaca'}
    </button>
  );
}
