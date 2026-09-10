import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { safeReturnTo } from '@intradocs/core/validation';
import { LoginForm } from '@/components/login-form';
import { Icon } from '@/components/icon';
export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentActor()) redirect('/help-center');
  const params = await searchParams;
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
        <span className="hero-badge">
          <Icon name="shield" size={14} />
          Satu sumber pengetahuan tim
        </span>
        <h1>
          Dokumentasi yang jelas.
          <br />
          <em>Akses yang tepat.</em>
        </h1>
        <p>
          Temukan panduan, baca versi yang tersedia, dan jaga pengetahuan internal tetap berada
          dalam lingkup yang berwenang.
        </p>
        <div className="login-proof">
          <Icon name="lock" />
          <span>
            Autentikasi nyata
            <br />
            <small>Session server + row-level security</small>
          </span>
        </div>
        <div className="login-proof">
          <Icon name="book" />
          <span>
            Reader Markdown
            <br />
            <small>Sumber immutable, tanpa menjalankan HTML</small>
          </span>
        </div>
        <span className="login-profile">M3 · Local development · AI off</span>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="pill p-blue">SELAMAT DATANG</span>
          <h2>Masuk ke Knowledge Hub</h2>
          <p className="sub">Gunakan akun sintetis dari setup lokal Anda.</p>
          <LoginForm returnTo={safeReturnTo(params.returnTo)} />
          <div className="callout c-info">
            <Icon name="help" />
            <div>
              Credential acak tersedia di <code>var/demo-accounts.json</code> setelah{' '}
              <code>pnpm setup:local</code>. Tidak ada pendaftaran publik.
            </div>
          </div>
          <p className="privacy-note">
            Jangan gunakan password perusahaan atau memasukkan data Telkom nyata ke lingkungan demo
            ini.
          </p>
        </div>
      </section>
    </main>
  );
}
