'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES, ROLE_LABELS, type Role } from '@intradocs/core';
export function UserAssignment({
  id,
  initialRole,
  scopeAll,
  categoryIds,
  categories,
  superAdmin,
  own,
}: {
  id: string;
  initialRole: Role;
  scopeAll: boolean;
  categoryIds: string[];
  categories: { id: string; name: string }[];
  superAdmin: boolean;
  own: boolean;
}) {
  const [role, setRole] = useState(initialRole),
    [all, setAll] = useState(scopeAll),
    [selected, setSelected] = useState(categoryIds),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const router = useRouter();
  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/users/${id}/assignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, scopeAll: all, categoryIds: all ? [] : selected }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Perubahan ditolak.');
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
  return (
    <details className="assignment-editor">
      <summary>Edit penugasan</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="workflow-fields">
          <label>
            Role
            <select className="inp" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.filter(
                (r) => superAdmin || !['super_admin', 'knowledge_admin'].includes(r),
              ).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {superAdmin && (
            <label className="upload-check">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              Semua kategori
            </label>
          )}
          <fieldset disabled={all}>
            <legend>Scope kategori</legend>
            {categories.map((c) => (
              <label className="upload-check" key={c.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={(e) =>
                    setSelected((a) =>
                      e.target.checked ? [...a, c.id] : a.filter((x) => x !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </fieldset>
          <p className="hint">
            Perubahan izin berlaku pada request berikutnya; tidak memberi grant sensitif otomatis.
          </p>
          <button className="btn btn-p">Simpan penugasan</button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </details>
  );
}
