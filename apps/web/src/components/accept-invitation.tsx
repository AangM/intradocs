'use client';
import { useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

const ROLE_LABELS: Record<string, string> = {
  knowledge_admin: 'Admin Knowledge',
  reviewer: 'Reviewer',
  contributor: 'Contributor',
  viewer: 'Viewer',
};

/**
 * Sets the password for an invited account. Same guard as the login form: disabled
 * until hydrated so a native submit can never put the password in a URL.
 */
export function AcceptInvitation({
  token,
  invitation,
}: {
  token: string;
  invitation: {
    email: string;
    name: string;
    unit: string;
    role: string;
    roleLabel?: string | null;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const ready = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) {
      setError('Password dan konfirmasinya berbeda.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Undangan tidak dapat diselesaikan.');
        return;
      }
      setDone(true);
    } catch {
      setError('Tidak dapat menghubungi layanan lokal.');
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <>
        <h2>Akun siap</h2>
        <p className="sub">
          Akun untuk <strong>{invitation.email}</strong> sudah aktif sebagai{' '}
          {invitation.roleLabel ?? ROLE_LABELS[invitation.role] ?? invitation.role}. Masuk dengan
          password yang barusan Anda tetapkan.
        </p>
        <button
          type="button"
          className="btn btn-p full-width"
          onClick={() => router.replace('/login')}
        >
          Ke halaman masuk
          <Icon name="arrow-r" size={16} />
        </button>
      </>
    );

  return (
    <>
      <h2>Undangan bergabung</h2>
      <p className="sub">
        {invitation.name}, Anda diundang sebagai{' '}
        <strong>{invitation.roleLabel ?? ROLE_LABELS[invitation.role] ?? invitation.role}</strong>{' '}
        di unit <strong>{invitation.unit}</strong>. Tetapkan password untuk{' '}
        <strong>{invitation.email}</strong>.
      </p>
      <form onSubmit={submit} className="login-form">
        <div className="field">
          <label htmlFor="password">Password baru</label>
          <input
            className="inp"
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </div>
        <div className="field">
          <label htmlFor="confirm">Ulangi password</label>
          <input
            className="inp"
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </div>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-p full-width" disabled={busy || !ready}>
          {busy ? 'Menyiapkan akun…' : 'Aktifkan akun'}
          <Icon name="check" size={16} />
        </button>
        <p className="sub tiny">
          Minimal 12 karakter. Tautan ini sekali pakai dan kedaluwarsa 72 jam setelah dibuat.
        </p>
      </form>
    </>
  );
}
