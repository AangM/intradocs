'use client';
import { useState } from 'react';
/**
 * The one thing on the settings page a person can change: whether the bell's items
 * also reach their inbox. Saved at once; the tile says what happened.
 */
export function EmailSwitch({ initial, mailOn }: { initial: boolean; mailOn: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setNote('');
    const next = !on;
    try {
      const r = await fetch('/api/users/me/email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error();
      setOn(next);
      setNote(next ? 'Email diaktifkan.' : 'Email dimatikan; lonceng tetap berjalan.');
    } catch {
      setNote('Tidak tersimpan. Coba lagi.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="email-switch">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`switch${on ? ' is-on' : ''}`}
        onClick={toggle}
        disabled={busy}
        aria-describedby="email-switch-note"
      >
        <span className="switch-knob" aria-hidden="true" />
        <span className="switch-label">{on ? 'Aktif' : 'Nonaktif'}</span>
      </button>
      <p id="email-switch-note" className="sub tiny">
        {note ||
          (mailOn
            ? 'Pemberitahuan dikirim sebagai ringkasan, paling cepat beberapa menit setelah kejadian.'
            : 'Pengiriman email belum dikonfigurasi di instalasi ini (MAIL_MODE=off); pilihan tetap tersimpan.')}
      </p>
    </div>
  );
}
