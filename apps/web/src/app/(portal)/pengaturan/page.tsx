import { requireActor } from '@/lib/session';
import { ROLE_LABELS } from '@intradocs/core';
import { PageHeading, Notice } from '@/components/shared';
import { aiStatus } from '@/lib/rag';
export default async function Settings() {
  const actor = await requireActor();
  const ai = aiStatus();
  const aiLabel =
    ai.retrieval === 'off'
      ? 'AI belum diaktifkan'
      : ai.generation === 'off'
        ? 'AI retrieval lokal (WeKnora) · tanpa penyusunan jawaban'
        : ai.generationLocation === 'external'
          ? 'AI retrieval lokal · jawaban disusun provider eksternal'
          : 'AI retrieval + jawaban lokal (WeKnora + Ollama)';
  return (
    <div className="pad">
      <PageHeading
        title="Pengaturan & Status Fitur"
        subtitle="Akun Anda dan fitur yang aktif pada instalasi ini."
      />
      <section className="card card-b">
        <dl className="settings-list">
          <div>
            <dt>Profil</dt>
            <dd>local-dev · corpus sintetis</dd>
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
            <dt>AI</dt>
            <dd>{aiLabel} · tidak ada request ke cloud</dd>
          </div>
          <div>
            <dt>SSO</dt>
            <dd>Belum terhubung · identitas lokal dan undangan admin</dd>
          </div>
        </dl>
      </section>
      <Notice>
        <strong>Privasi.</strong> Semuanya berjalan di mesin ini — tidak ada layanan AI cloud,
        analytics, telemetry, atau font dari luar. Tautan keluar hanya dibuka saat Anda klik.
      </Notice>
      <Notice kind="warn">
        <strong>Lingkungan demo.</strong> Jangan masukkan data atau credential perusahaan yang
        nyata; seluruh isi bersifat sintetis. Syarat pilot ada di docs/PLAN.md.
      </Notice>
    </div>
  );
}
