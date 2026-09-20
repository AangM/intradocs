'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CAPABILITY_LABELS,
  CUSTOM_ROLE_BASES,
  ROLE_COLORS,
  ROLE_LABELS,
  roleCapabilities,
  type Capability,
  type CustomRole,
  type Role,
} from '@intradocs/core';
import { Icon } from './icon';
import { toast } from './toast';

type Draft = {
  id: string | null;
  revision: number;
  name: string;
  description: string;
  color: string;
  baseRole: (typeof CUSTOM_ROLE_BASES)[number];
  denied: Capability[];
};

const EMPTY: Draft = {
  id: null,
  revision: 0,
  name: '',
  description: '',
  color: 'sky',
  baseRole: 'viewer',
  denied: [],
};

const COLOR_NAMES: Record<string, string> = {
  blue: 'Biru',
  red: 'Merah',
  violet: 'Ungu',
  green: 'Hijau',
  amber: 'Amber',
  sky: 'Langit',
};

/**
 * Custom roles (S08). Each one is a name over a built-in base role that can only take
 * capabilities away; the cards show what the role keeps, the dialog lets a super admin
 * shape it. Nothing here can grant more than the base role does -- the database keeps
 * enforcing the base role, and the server refuses a denial the base never had.
 */
export function CustomRoles({
  roles,
  canManage,
  userCounts,
}: {
  roles: CustomRole[];
  canManage: boolean;
  /** Holders visible to the current admin, per role id. */
  userCounts: Record<string, number>;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  function open(role?: CustomRole) {
    setError('');
    setDraft(
      role
        ? {
            id: role.id,
            revision: role.revision,
            name: role.name,
            description: role.description,
            color: role.color,
            baseRole: role.baseRole,
            denied: role.deniedCapabilities,
          }
        : EMPTY,
    );
    dialog.current?.showModal();
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        color: draft.color,
        baseRole: draft.baseRole,
        deniedCapabilities: draft.denied,
        ...(draft.id ? { revision: draft.revision } : {}),
      };
      const r = await fetch(draft.id ? `/api/roles/${draft.id}` : '/api/roles', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Tidak dapat menyimpan.');
      dialog.current?.close();
      toast(draft.id ? 'Role kustom diperbarui' : 'Role kustom dibuat');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tidak dapat menyimpan.');
    } finally {
      setBusy(false);
    }
  }
  async function archive(role: CustomRole) {
    setBusy(true);
    try {
      const r = await fetch(`/api/roles/${role.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: role.revision }),
      });
      const v = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(v.error ?? 'Tidak dapat mengarsipkan.');
      toast('Role kustom diarsipkan', 'info');
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Tidak dapat mengarsipkan.', 'error');
    } finally {
      setBusy(false);
      setConfirmArchive(null);
    }
  }
  const baseCaps = roleCapabilities(draft.baseRole);
  // The base role is locked once the role has holders (the server refuses the change too).
  const baseLocked = Boolean(draft.id) && (userCounts[draft.id ?? ''] ?? 0) > 0;
  // Denials that the newly chosen base never had are dropped, so the checklist below is
  // always a subset of what the base grants.
  function setBase(base: Draft['baseRole']) {
    const caps = roleCapabilities(base);
    setDraft((d) => ({ ...d, baseRole: base, denied: d.denied.filter((c) => caps.includes(c)) }));
  }

  return (
    <>
      {roles.map((role) => {
        const kept = roleCapabilities(role.baseRole).filter(
          (c) => !role.deniedCapabilities.includes(c),
        );
        return (
          <div key={role.id} className={`role-card role-custom tone-${role.color}`}>
            <div className="rt">
              <span className="ft" style={{ background: 'var(--tone)' }}>
                <Icon name="users" size={16} />
              </span>
              <div>
                <strong>{role.name}</strong>
                <p className="role-count">
                  {userCounts[role.id] ?? 0} pengguna · berbasis {ROLE_LABELS[role.baseRole]}
                </p>
              </div>
            </div>
            <p className="rd">{role.description || 'Tanpa deskripsi.'}</p>
            <div className="role-caps">
              {kept.length ? (
                kept.map((c) => (
                  <span key={c} className="pill p-grey">
                    {CAPABILITY_LABELS[c]}
                  </span>
                ))
              ) : (
                <span className="sub tiny">Hanya membaca sesuai cakupan.</span>
              )}
              {role.deniedCapabilities.map((c) => (
                <span key={c} className="pill p-red role-denied" title="Dicabut dari role dasar">
                  <Icon name="x" size={11} /> {CAPABILITY_LABELS[c]}
                </span>
              ))}
            </div>
            {canManage &&
              (confirmArchive === role.id ? (
                <div className="row role-actions" role="group" aria-label="Konfirmasi arsip">
                  <span className="sub tiny">Arsipkan role ini?</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void archive(role)}
                  >
                    Ya, arsipkan
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setConfirmArchive(null)}
                  >
                    Batal
                  </button>
                </div>
              ) : (
                <div className="row role-actions">
                  <button type="button" className="btn btn-sm" onClick={() => open(role)}>
                    <Icon name="edit" size={13} /> Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-r"
                    disabled={role.holders > 0}
                    title={
                      role.holders > 0
                        ? 'Pindahkan dulu pemegangnya ke role lain'
                        : 'Arsipkan role ini'
                    }
                    onClick={() => setConfirmArchive(role.id)}
                  >
                    Arsipkan
                  </button>
                </div>
              ))}
          </div>
        );
      })}
      {canManage ? (
        <button type="button" className="role-card role-pending role-add" onClick={() => open()}>
          <div>
            <Icon name="plus" size={23} style={{ margin: '0 auto 8px' }} />
            <strong>Role kustom baru</strong>
            <span className="sub tiny">Turunan role bawaan dengan kemampuan yang dipersempit</span>
          </div>
        </button>
      ) : roles.length === 0 ? (
        <div className="role-card role-pending">
          <div>
            <Icon name="users" size={23} style={{ margin: '0 auto 8px' }} />
            <strong>Role kustom</strong>
            <span className="sub tiny">Didefinisikan oleh Super Admin</span>
          </div>
        </div>
      ) : null}

      <dialog
        ref={dialog}
        className="glass-dialog role-dialog"
        aria-labelledby="role-dialog-title"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="dialog-head">
            <div className="dialog-title">
              <span className={`nt-ic tone-${draft.color}`} style={{ color: 'var(--tone)' }}>
                <Icon name="users" size={15} />
              </span>
              <div>
                <h3 id="role-dialog-title">{draft.id ? 'Edit role kustom' : 'Role kustom baru'}</h3>
                <span className="sub tiny">
                  Hanya mempersempit role dasarnya; tidak pernah menambah.
                </span>
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Tutup"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <fieldset disabled={busy} className="dialog-body">
            <div className="grid g2">
              <label className="field-lbl">
                Nama role
                <input
                  className="inp"
                  required
                  minLength={2}
                  maxLength={40}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="mis. Penulis SOP"
                />
              </label>
              <label className="field-lbl">
                Warna
                <select
                  className="inp"
                  value={draft.color}
                  onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                >
                  {ROLE_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {COLOR_NAMES[c]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field-lbl">
              Deskripsi
              <input
                className="inp"
                maxLength={240}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Satu kalimat tentang siapa yang memegang role ini"
              />
            </label>
            <div className="field-lbl">
              Role dasar
              <div className="choice-grid" role="group" aria-label="Role dasar">
                {CUSTOM_ROLE_BASES.map((r) => (
                  <label className="choice" key={r}>
                    <input
                      type="radio"
                      name="base-role"
                      checked={draft.baseRole === r}
                      disabled={baseLocked}
                      onChange={() => setBase(r)}
                    />
                    {ROLE_LABELS[r as Role]}
                  </label>
                ))}
              </div>
              {baseLocked && (
                <span className="sub tiny">Role dasar terkunci selama masih ada pemegangnya.</span>
              )}
            </div>
            <div className="field-lbl">
              Kemampuan yang dipertahankan
              <div className="choice-grid" role="group" aria-label="Kemampuan">
                {baseCaps.length ? (
                  baseCaps.map((c) => {
                    const on = !draft.denied.includes(c);
                    return (
                      <label className="choice" key={c}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              denied: e.target.checked
                                ? draft.denied.filter((x) => x !== c)
                                : [...draft.denied, c],
                            })
                          }
                        />
                        {CAPABILITY_LABELS[c]}
                      </label>
                    );
                  })
                ) : (
                  <span className="sub tiny">
                    {ROLE_LABELS[draft.baseRole as Role]} hanya membaca; tidak ada yang bisa
                    dipersempit selain cakupannya.
                  </span>
                )}
              </div>
            </div>
            <p className="hint">
              Batas baca dokumen (klasifikasi, cakupan kategori, grant) mengikuti role dasar dan
              tetap ditegakkan database. Yang dicabut di sini ditolak aplikasi pada setiap
              permintaan.
            </p>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </fieldset>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Batal
            </button>
            <button type="submit" className="btn btn-p" disabled={busy}>
              {busy ? 'Menyimpan…' : draft.id ? 'Simpan' : 'Buat role'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
