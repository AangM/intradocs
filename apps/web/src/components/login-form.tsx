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
    <form onSubmit={submit} className="login-form">
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          className="inp"
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="nama@example.test"
          required
          maxLength={254}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          className="inp"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
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
        {busy ? 'Memeriksa akun…' : 'Masuk ke IntraDocs'}
        <Icon name="arrow-r" size={16} />
      </button>
      <div className="login-separator">
        <span>Identitas perusahaan</span>
      </div>
      <button
        className="btn full-width"
        type="button"
        disabled={!sso || busy || !ready}
        aria-describedby="sso-note"
        onClick={startSso}
      >
        <Icon name="shield" size={16} />
        {sso ? `Masuk dengan ${sso}` : 'Masuk dengan SSO'}
      </button>
      <p id="sso-note" className="sub tiny login-note">
        {sso
          ? 'Hanya untuk akun yang sudah diundang admin; SSO tidak membuat akun baru.'
          : 'Belum terhubung: AUTH_MODE=oidc dan IdP organisasi belum dikonfigurasi.'}
      </p>
    </form>
  );
}
