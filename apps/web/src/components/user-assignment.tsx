'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES, ROLE_LABELS, initials, type CustomRole, type Role } from '@intradocs/core';
import { Icon } from './icon';
import { toast } from './toast';
/**
 * Role and category scope for one account, edited in a native <dialog>: it floats above
 * the (horizontally scrolling) table instead of unfolding inside a cell, closes on
 * Escape and on the backdrop, and needs no positioning code.
 */
export function UserAssignment({
  id,
  name,
  initialRole,
  initialCustomRoleId = null,
  customRoles = [],
  scopeAll,
  categoryIds,
  categories,
  superAdmin,
  own,
}: {
  id: string;
  /** Shown in the dialog title so the person being edited is never in doubt. */
  name: string;
  initialRole: Role;
  initialCustomRoleId?: string | null;
  customRoles?: CustomRole[];
  scopeAll: boolean;
  categoryIds: string[];
  categories: { id: string; name: string }[];
  superAdmin: boolean;
  own: boolean;
}) {
  // One <select> lists built-in roles and custom roles together; a custom choice is
  // "custom:<id>" and resolves to its base role plus the id on save.
  const [choice, setChoice] = useState(
      initialCustomRoleId ? `custom:${initialCustomRoleId}` : initialRole,
    ),
    [all, setAll] = useState(scopeAll),
    [selected, setSelected] = useState(categoryIds),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement | null>(null);
  const router = useRouter();
  const chosenCustom = choice.startsWith('custom:')
    ? customRoles.find((c) => c.id === choice.slice('custom:'.length))
    : undefined;
  const role: Role = chosenCustom ? chosenCustom.baseRole : (choice as Role);
  const customRoleId = chosenCustom?.id ?? null;
  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/users/${id}/assignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          customRoleId,
          scopeAll: all,
          categoryIds: all ? [] : selected,
        }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Perubahan ditolak.');
      dialog.current?.close();
      toast('Role & cakupan disimpan');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tidak dapat menyimpan.');
    } finally {
      setBusy(false);
    }
  }
  if (own) return <span className="sub">Akun sendiri — penugasan dikunci</span>;
  if (!superAdmin && ['super_admin', 'knowledge_admin'].includes(initialRole))
    return <span className="sub">Hanya Super Admin</span>;
  const roles = ROLES.filter((r) => superAdmin || !['super_admin', 'knowledge_admin'].includes(r));
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setError('');
          dialog.current?.showModal();
        }}
      >
        <Icon name="edit" size={13} />
        Edit penugasan
      </button>
      <dialog
        ref={dialog}
        className="glass-dialog"
        aria-labelledby={`assign-${id}`}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) dialog.current?.close();
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
              <span className="avatar avatar-xs">{initials(name)}</span>
              <div>
                <h3 id={`assign-${id}`}>Role & cakupan</h3>
                <span className="sub tiny">{name}</span>
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
            <label className="field-lbl">
              Role
              <select className="inp" value={choice} onChange={(e) => setChoice(e.target.value)}>
                <optgroup label="Role bawaan">
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </optgroup>
                {customRoles.filter((c) => roles.includes(c.baseRole)).length > 0 && (
                  <optgroup label="Role kustom">
                    {customRoles
                      .filter((c) => roles.includes(c.baseRole))
                      .map((c) => (
                        <option key={c.id} value={`custom:${c.id}`}>
                          {c.name} · berbasis {ROLE_LABELS[c.baseRole]}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </label>
            <div className="field-lbl">
              Cakupan kategori
              <div className="choice-grid" role="group" aria-label="Cakupan kategori">
                {superAdmin && (
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={(e) => setAll(e.target.checked)}
                    />
                    <Icon name="layers" size={13} />
                    Semua kategori
                  </label>
                )}
                {categories.map((c) => (
                  <label className="choice" key={c.id}>
                    <input
                      type="checkbox"
                      disabled={all}
                      checked={all || selected.includes(c.id)}
                      onChange={(e) =>
                        setSelected((a) =>
                          e.target.checked ? [...a, c.id] : a.filter((x) => x !== c.id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
            <p className="hint">
              Berlaku pada permintaan berikutnya. Dokumen Terbatas/Rahasia tetap butuh grant
              tersendiri.
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
              {busy ? 'Menyimpan…' : 'Simpan'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
