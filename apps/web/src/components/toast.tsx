'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icon';

export type ToastTone = 'ok' | 'info' | 'warn' | 'error';
type ToastItem = { id: number; message: string; tone: ToastTone; leaving: boolean };

const EVENT = 'intradocs:toast';
const SHOW_MS = 4200;

/**
 * Say what just happened, once, in the corner. Any client component calls
 * `toast('Favorit disimpan')` after a mutation succeeds; the <Toaster> mounted in the
 * shell renders it and lets it go after a few seconds. No provider or context: a window
 * event is enough, and a toast fired before the shell mounts is simply lost.
 */
export function toast(message: string, tone: ToastTone = 'ok') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, tone } }));
}

const ICONS: Record<ToastTone, string> = {
  ok: 'check',
  info: 'shield',
  warn: 'alert',
  error: 'x',
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let seq = 0;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const dismiss = (id: number) => {
      setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      timers.set(
        id,
        setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 200),
      );
    };
    const onToast = (e: Event) => {
      const { message, tone } = (e as CustomEvent<{ message: string; tone: ToastTone }>).detail;
      const id = ++seq;
      setItems((list) => [...list.slice(-2), { id, message, tone, leaving: false }]);
      timers.set(
        id,
        setTimeout(() => dismiss(id), SHOW_MS),
      );
    };
    window.addEventListener(EVENT, onToast);
    return () => {
      window.removeEventListener(EVENT, onToast);
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone} ${t.leaving ? 'leaving' : ''}`}>
          <span className="toast-ic">
            <Icon name={ICONS[t.tone]} size={14} />
          </span>
          <span>{t.message}</span>
          <button
            type="button"
            className="toast-x"
            aria-label="Tutup"
            onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
