'use client';
import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';
import { safeReturnTo } from '@intradocs/core/validation';
import { Icon } from './icon';
export function LoginForm({
  returnTo,
  sso,
  ssoError,
}: {
  returnTo: string;
  /** Label of the organisation's IdP when AUTH_MODE=oidc; null when SSO is not wired. */
  sso: string | null;
  /** Message from a failed SSO callback, already translated by the page. */
  ssoError: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(ssoError);
  const [showPassword, setShowPassword] = useState(false);
  // The form has no action/method, so a submit before React attaches onSubmit falls back
  // to a native GET and puts the password in the URL, the history and the server log --
  // observed as `GET /login?email=...&password=...` in a real run. Staying disabled until
  // mount closes that window; it also removes the click-before-hydration race in tests.
  // false while server-rendered, true once the client store is read after hydration.
  // useSyncExternalStore rather than an effect, so no state is set during render.
  const ready = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? '').trim(),
          password: String(form.get('password') ?? ''),
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? 'Terlalu banyak percobaan. Tunggu satu menit.'
            : 'Email atau password tidak sesuai, atau akun tidak aktif.',
        );
        return;
      }
      router.replace(safeReturnTo(returnTo));
      router.refresh();
    } catch {
      setError('Tidak dapat menghubungi layanan login. Pastikan server lokal aktif.');
    } finally {
      setBusy(false);
    }
  }
  async function startSso() {
    if (busy || !sso) return;
    setBusy(true);
    setError('');
    try {
      // Better Auth answers with the IdP's authorization URL (state and PKCE verifier
      // already stored server-side); the browser follows it from here.
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'sso',
          callbackURL: safeReturnTo(returnTo),
          errorCallbackURL: '/login?sso=gagal',
          disableRedirect: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as { url?: string } | null;
      if (!response.ok || !body?.url) {
        setError('SSO tidak dapat dimulai. Coba lagi atau hubungi admin.');
        setBusy(false);
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError('Tidak dapat menghubungi layanan login.');
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="auth-form">
      <div className="auth-field">
        <label htmlFor="email">Email</label>
        <input
          className="auth-input"
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="nama@perusahaan.co.id"
          required
          maxLength={254}
        />
      </div>
      <div className="auth-field">
        <label htmlFor="password">Password</label>
        <div className="auth-password">
          <input
            className="auth-input"
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            minLength={12}
            maxLength={128}
          />
          <button
            type="button"
            className="auth-reveal"
            aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            <Icon name="eye" size={16} />
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="auth-error">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}
      <button type="submit" className="auth-submit" disabled={busy || !ready}>
        {busy ? 'Memeriksa…' : 'Masuk'}
      </button>
      {/* SSO appears only when an IdP is configured; there is nothing to explain otherwise. */}
      {sso && (
        <>
          <div className="auth-divider">
            <span>atau</span>
          </div>
          <button className="auth-sso" type="button" disabled={busy || !ready} onClick={startSso}>
            <Icon name="shield" size={16} />
            Masuk dengan {sso}
          </button>
        </>
      )}
    </form>
  );
}
