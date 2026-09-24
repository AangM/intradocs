import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { safeReturnTo } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { LoginForm } from '@/components/login-form';
import { Icon } from '@/components/icon';
import '../login.css';
export const dynamic = 'force-dynamic';

// Layout pattern of mature knowledge-base sign-ins (form card on one side, one line and a
// glimpse of the product on the other); the glimpse is IntraDocs' own answer card.
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
    <main className="signin">
      <section className="signin-main">
        <div className="signin-logo">
          <span className="signin-mark">
            <Icon name="book" size={18} />
          </span>
          <span>
            IntraDocs<small>Knowledge Hub · Divisi IT</small>
          </span>
        </div>
        <h1>Selamat datang kembali</h1>
        <div className="signin-card">
          <LoginForm
            returnTo={safeReturnTo(params.returnTo)}
            sso={sso?.label ?? null}
            ssoError={ssoError}
          />
        </div>
        <p className="signin-help">
          Belum punya akun? Minta undangan ke admin.
          {!config.hardened && (
            <>
              <br />
              Akun demo: <code>var/demo-accounts.json</code>
            </>
          )}
        </p>
      </section>
      <aside className="signin-aside" aria-hidden="true">
        <p className="signin-tagline">
          Semua SOP dan panduan IT di satu tempat.
          <strong>Tanya, dan dapat jawaban bersumber.</strong>
        </p>
        <div className="signin-preview">
          <div className="signin-preview-bar">
            <span />
            <span />
            <span />
          </div>
          <div className="signin-q">
            <span className="signin-avatar">S</span>
            Apakah MFA wajib untuk VPN lab?
          </div>
          <div className="signin-a">
            <span className="signin-avatar ai">
              <Icon name="spark" size={13} />
            </span>
            <div>
              <p>Ya. Profil VPN laboratorium mensyaratkan akun uji dan MFA saat masuk.</p>
              <span className="signin-cite">
                <Icon name="file" size={12} />
                Konfigurasi VPN · Langkah 2
              </span>
            </div>
          </div>
          <div className="signin-chips">
            <span>
              <Icon name="lock" size={12} /> Sesuai akses
            </span>
            <span>
              <Icon name="check-c" size={12} /> Versi resmi
            </span>
          </div>
        </div>
      </aside>
    </main>
  );
}
