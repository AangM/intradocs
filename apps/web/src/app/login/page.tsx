import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { safeReturnTo } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { LoginForm } from '@/components/login-form';
import { Icon } from '@/components/icon';
import '../login.css';
export const dynamic = 'force-dynamic';

/** Three facts about the portal, a few words each; the page itself is the sign-in. */
const POINTS = [
  { icon: 'spark', text: 'Jawaban dengan sumber' },
  { icon: 'lock', text: 'Sesuai hak akses' },
  { icon: 'check-c', text: 'Selalu versi resmi' },
];

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentActor()) redirect('/help-center');
  const params = await searchParams;
  const config = readRuntimeConfig(process.env);
  const sso = config.sso;
  // Better Auth sends the callback's failure back here as ?error=...; the only case a
  // person can act on is "nobody invited this address", so that is the one named.
  const errorCode = typeof params.error === 'string' ? params.error : '';
  const ssoError =
    params.sso === 'gagal' || errorCode
      ? /signup_disabled|account_not_found|user_not_found/i.test(errorCode)
        ? 'Akun SSO ini belum diundang ke IntraDocs. Minta undangan dari admin.'
        : 'Masuk lewat SSO tidak berhasil. Coba lagi atau hubungi admin.'
      : '';
  return (
    <main className="auth">
      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-logo">
          <span className="auth-mark">
            <Icon name="book" size={18} />
          </span>
          IntraDocs
        </div>
        <div className="auth-brand-body">
          <p className="auth-headline">
            Pengetahuan tim,
            <br />
            satu sumber tepercaya.
          </p>
          <ul className="auth-points">
            {POINTS.map((p) => (
              <li key={p.text}>
                <Icon name={p.icon} size={16} />
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        <span className="auth-foot">Knowledge Hub · Divisi IT</span>
      </aside>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-logo auth-logo-compact" aria-hidden="true">
            <span className="auth-mark">
              <Icon name="book" size={18} />
            </span>
            IntraDocs
          </div>
          <h1>Masuk</h1>
          <p className="auth-sub">Gunakan akun IntraDocs Anda.</p>
          <LoginForm
            returnTo={safeReturnTo(params.returnTo)}
            sso={sso?.label ?? null}
            ssoError={ssoError}
          />
          <p className="auth-help">
            Belum punya akun? Akun dibuat lewat undangan admin.
            {!config.hardened && (
              <>
                <br />
                Demo lokal: <code>var/demo-accounts.json</code>
              </>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
