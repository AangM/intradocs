import { requireActor } from '@/lib/session';
import { ROLE_LABELS, initials, roleLabel } from '@intradocs/core';
import { PageHeading, Notice } from '@/components/shared';
import { Icon } from '@/components/icon';
import { aiStatus } from '@/lib/rag';

export default async function Settings() {
  const actor = await requireActor();
  const ai = aiStatus();
  const aiOn = ai.retrieval !== 'off';
  const aiLabel = !aiOn
    ? 'Belum diaktifkan'
    : ai.generation === 'off'
      ? 'Retrieval lokal (WeKnora), tanpa penyusunan jawaban'
      : ai.generationLocation === 'external'
        ? 'Retrieval lokal, jawaban dari provider eksternal'
        : 'Retrieval + jawaban lokal (WeKnora + Ollama)';
  // One tile per fact: an icon, the value, one line of context, and a state chip where
  // there is a state to show. Nothing here is editable on this build.
  const tiles: Array<{
    icon: string;
    tone: string;
    label: string;
    value: string;
    note: string;
    chip?: { text: string; pill: string };
  }> = [
    {
      icon: 'users',
      tone: 'nt-info',
      label: 'Akun Anda',
      value: actor.name,
      note: `${roleLabel(actor)}${actor.customRole ? ` (berbasis ${ROLE_LABELS[actor.role]})` : ''} · ${actor.unit}`,
      chip: { text: 'Aktif', pill: 'p-green' },
    },
    {
      icon: 'layers',
      tone: 'nt-info',
      label: 'Cakupan',
      value: actor.scopeAll ? 'Semua kategori' : 'Kategori yang ditugaskan',
      note: 'Dokumen Terbatas/Rahasia tetap butuh grant per dokumen.',
    },
    {
      icon: 'spark',
      tone: 'nt-ai',
      label: 'AI Assistant',
      value: aiLabel,
      note: 'Tidak ada request ke cloud.',
      chip: aiOn ? { text: 'Berjalan lokal', pill: 'p-ai' } : { text: 'Off', pill: 'p-grey' },
    },
    {
      icon: 'lock',
      tone: 'nt-review',
      label: 'Autentikasi',
      value: 'Email & password lokal',
      note: 'Better Auth · tanpa pendaftaran publik.',
    },
    {
      icon: 'globe',
      tone: 'nt-block',
      label: 'SSO perusahaan',
      value: 'Belum terhubung',
      note: 'Identitas lokal dan undangan admin.',
      chip: { text: 'Direncanakan', pill: 'p-amber' },
    },
    {
      icon: 'db',
      tone: 'nt-ok',
      label: 'Penyimpanan',
      value: 'Filesystem privat',
      note: 'Di luar webroot; setiap versi tersimpan apa adanya.',
    },
    {
      icon: 'server',
      tone: 'nt-ok',
      label: 'Profil instalasi',
      value: 'local-dev',
      note: 'Corpus sintetis untuk pengujian.',
      chip: { text: 'Demo', pill: 'p-amber' },
    },
  ];
  return (
    <div className="pad">
      <PageHeading
        title="Pengaturan & Status Fitur"
        subtitle="Akun Anda dan fitur yang aktif pada instalasi ini."
      />
      <div className="settings-hero card">
        <span className="avatar avatar-lg">{initials(actor.name)}</span>
        <div>
          <div className="settings-name">{actor.name}</div>
          <div className="sub">
            {roleLabel(actor)}
            {actor.customRole ? ` (berbasis ${ROLE_LABELS[actor.role]})` : ''} · {actor.unit}
          </div>
        </div>
        <span className="pill p-amber">Lokal · data sintetis</span>
      </div>
      <div className="settings-grid">
        {tiles.map((t) => (
          <section className="card settings-tile" key={t.label}>
            <span className={`nt-ic ${t.tone}`} aria-hidden="true">
              <Icon name={t.icon} size={16} />
            </span>
            <div className="settings-tile-b">
              <div className="settings-tile-l">{t.label}</div>
              <div className="settings-tile-v">{t.value}</div>
              <div className="settings-tile-n">{t.note}</div>
            </div>
            {t.chip && <span className={`pill ${t.chip.pill}`}>{t.chip.text}</span>}
          </section>
        ))}
      </div>
      <Notice>
        <strong>Privasi.</strong> Semuanya berjalan di mesin ini — tanpa AI cloud, analytics,
        telemetry, atau font dari luar.
      </Notice>
      <Notice kind="warn">
        <strong>Lingkungan demo.</strong> Jangan masukkan data atau credential perusahaan yang
        nyata; syarat pilot ada di docs/PLAN.md.
      </Notice>
    </div>
  );
}
