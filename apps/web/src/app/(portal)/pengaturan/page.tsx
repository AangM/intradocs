import { requireActor } from '@/lib/session';
import { ROLE_LABELS } from '@intradocs/core';
import { PageHeading, Notice } from '@/components/shared';
export default async function Settings() {
  const actor = await requireActor();
  return (
    <div className="pad">
      <PageHeading
        title="Pengaturan & Status Fitur"
        subtitle="Konfigurasi build lokal ini bersifat fail-closed dan tidak dapat mengaktifkan cloud melalui UI."
      />
      <section className="card card-b">
        <dl className="settings-list">
          <div>
            <dt>Profil</dt>
            <dd>local-dev · M3</dd>
          </div>
          <div>
            <dt>Autentikasi</dt>
            <dd>Better Auth · email/password lokal</dd>
          </div>
          <div>
            <dt>Akun Anda</dt>
            <dd>
              {actor.name} · {ROLE_LABELS[actor.role]}
            </dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>
              {actor.scopeAll
                ? 'Semua kategori (grant sensitif tetap berlaku)'
                : 'Kategori yang ditugaskan'}
            </dd>
          </div>
          <div>
            <dt>Penyimpanan</dt>
            <dd>Filesystem privat di luar webroot</dd>
          </div>
          <div>
            <dt>AI / SSO</dt>
            <dd>AI off · SSO belum terhubung</dd>
          </div>
        </dl>
      </section>
      <Notice>
        <strong>Privasi.</strong> Tidak ada integrasi telemetry aplikasi, API AI, analytics pihak
        ketiga, atau font remote. Next.js telemetry dimatikan oleh runner lokal. Tautan eksternal
        dalam dokumen hanya dibuka ketika Anda klik, tanpa referrer.
      </Notice>
      <Notice kind="warn">
        <strong>Belum layak data produksi.</strong> Jangan gunakan data atau credential Telkom
        nyata. M1–M3 diuji dengan corpus sintetis. Pilot nyata tetap menunggu SSO, kebijakan data,
        backup/restore, serta persetujuan mentor/security/ops. Lihat bukti rilis di docs/PLAN.md.
      </Notice>
    </div>
  );
}
