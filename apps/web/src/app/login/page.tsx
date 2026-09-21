import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { safeReturnTo } from '@intradocs/core/validation';
import { LoginForm } from '@/components/login-form';
import { Icon } from '@/components/icon';
import { readRuntimeConfig } from '@intradocs/core/config';
export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentActor()) redirect('/help-center');
  const params = await searchParams;
  const sso = readRuntimeConfig(process.env).sso;
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
    <main className="login-page">
      <section className="login-story">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="book" />
          </span>
          <span>
            IntraDocs<small>Knowledge Hub · Divisi IT</small>
          </span>
        </div>
        <div className="login-story-body">
          <span className="hero-badge">
            <Icon name="shield" size={14} />
            Satu tempat untuk pengetahuan tim
          </span>
          <p className="login-tagline">
            Tanya, temukan, <em>percaya.</em>
          </p>
          <p>
            SOP, panduan, dan kebijakan IT dalam satu tempat — dan asisten yang menjawab dari
            dokumen resmi, lengkap dengan sumbernya.
          </p>
          <div className="login-sample" aria-hidden="true">
            <div className="login-sample-q">
              <span className="avatar">S</span>
              Apakah MFA wajib untuk VPN lab?
            </div>
            <div className="login-sample-a">
              <span className="avatar ai">
                <Icon name="spark" size={13} />
              </span>
              <div>
                Ya. Profil VPN laboratorium mensyaratkan akun uji dan MFA saat masuk.
                <span className="login-sample-src">
                  <Icon name="file" size={12} />
                  Konfigurasi VPN · Langkah konfigurasi
                </span>
              </div>
            </div>
            <span className="login-sample-tag">Contoh · dokumen sintetis</span>
          </div>
          <div className="login-points">
            <div className="login-proof">
              <Icon name="spark" />
              <span>
                Jawaban bersumber
                <br />
                <small>Setiap jawaban menyebut dokumen dan bagiannya</small>
              </span>
            </div>
            <div className="login-proof">
              <Icon name="lock" />
              <span>
                Sesuai akses Anda
                <br />
                <small>Hanya dokumen yang boleh Anda baca yang muncul</small>
              </span>
            </div>
            <div className="login-proof">
              <Icon name="check-c" />
              <span>
                Selalu versi resmi
                <br />
                <small>Dokumen terbit setelah ditinjau; versi lama tetap tercatat</small>
              </span>
            </div>
          </div>
        </div>
        <span className="login-profile">Build lokal · seluruh data sintetis</span>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="pill p-blue">SELAMAT DATANG</span>
          <h1>Masuk ke IntraDocs</h1>
          <p className="sub">Pakai akun demo dari setup lokal Anda.</p>
          <LoginForm
            returnTo={safeReturnTo(params.returnTo)}
            sso={sso?.label ?? null}
            ssoError={ssoError}
          />
          <p className="privacy-note">
            <Icon name="help" size={14} />
            <span>
              Akun demo ada di <code>var/demo-accounts.json</code>; tidak ada pendaftaran publik.
              Jangan masukkan password atau data perusahaan yang nyata.
            </span>
          </p>
        </div>
      </section>
    </main>
  );
}
