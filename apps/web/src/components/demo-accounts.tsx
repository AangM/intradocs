'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { safeReturnTo } from '@intradocs/core/validation';
import { Icon } from './icon';
import { initials } from '@intradocs/core';

/**
 * Review aid: one click signs in as a synthetic account, so a reviewer can walk the
 * roles without copying passwords. To switch, "Keluar" returns here.
 */
export function DemoAccounts({
  accounts,
  returnTo,
}: {
  accounts: Array<{ email: string; name: string; roleLabel: string }>;
  returnTo: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function signIn(email: string) {
    if (busy) return;
    setBusy(email);
    setError('');
    try {
      const r = await fetch('/api/demo/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Tidak dapat masuk.');
        setBusy('');
        return;
      }
      router.replace(safeReturnTo(returnTo));
      router.refresh();
    } catch {
      setError('Tidak dapat menghubungi server.');
      setBusy('');
    }
  }
  return (
    <section className="demo-accounts" aria-labelledby="demo-accounts-title">
      <div className="login-separator">
        <span id="demo-accounts-title">Masuk cepat · akun demo</span>
      </div>
      <ul>
        {accounts.map((a) => (
          <li key={a.email}>
            <button
              type="button"
              className="demo-account"
              onClick={() => signIn(a.email)}
              disabled={!!busy}
              aria-label={`Masuk sebagai ${a.name}, ${a.roleLabel}`}
            >
              <span className="avatar">{initials(a.name)}</span>
              <span className="demo-account-b">
                <strong>{a.name}</strong>
                <span>{a.roleLabel}</span>
              </span>
              <Icon name={busy === a.email ? 'clock' : 'arrow-r'} size={14} />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <p className="sub tiny">Data sintetis. Untuk berganti akun, pilih Keluar lalu akun lain.</p>
    </section>
  );
}
