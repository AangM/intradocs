'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomRole } from '@intradocs/core';
import { Icon } from './icon';

interface Category {
  id: string;
  name: string;
}
export interface InvitationItem {
  id: string;
  email: string;
  name: string;
  unit: string;
  role: string;
  roleLabel?: string | null;
  scopeAll: boolean;
  categories: string[];
  createdAt: string;
  expiresAt: string;
  state: 'open' | 'accepted' | 'revoked' | 'expired';
}

const ROLE_LABELS: Record<string, string> = {
  knowledge_admin: 'Admin Knowledge',
  reviewer: 'Reviewer',
  contributor: 'Contributor',
  viewer: 'Viewer',
};
const STATE_LABELS: Record<InvitationItem['state'], string> = {
  open: 'Terbuka',
  accepted: 'Diterima',
  revoked: 'Dicabut',
  expired: 'Kedaluwarsa',
};

/**
 * "Undang pengguna", the local form: role and scope are fixed by the administrator up
 * front, the link is shown once and handed over by them (no mail), and the invitee only
 * ever sets a password. SSO stays a separate, honest "not here".
 */
export function InviteUser({
  categories,
  invitations,
  defaultUnit,
  canPickUnit,
  canScopeAll,
  customRoles = [],
}: {
  categories: Category[];
  invitations: InvitationItem[];
  defaultUnit: string;
  /** Super admins may invite into any unit; knowledge admins only their own. */
  canPickUnit: boolean;
  canScopeAll: boolean;
  customRoles?: CustomRole[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    unit: defaultUnit,
    role: 'viewer',
    scopeAll: false,
    categoryIds: [] as string[],
  });
  // "custom:<id>" in the select resolves to the custom role's base role plus its id.
  const [choice, setChoice] = useState('viewer');
  const chosenCustom = choice.startsWith('custom:')
    ? customRoles.find((c) => c.id === choice.slice('custom:'.length))
    : undefined;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          role: chosenCustom ? chosenCustom.baseRole : choice,
          customRoleId: chosenCustom?.id ?? null,
        }),
      });
      const body = (await r.json()) as { error?: string; link?: string };
      if (!r.ok || !body.link) throw new Error(body.error ?? 'Undangan gagal dibuat.');
      setLink({ email: form.email, url: body.link });
      setForm({ ...form, name: '', email: '', categoryIds: [] });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/invitations/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Gagal.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal.');
    } finally {
      setBusy(false);
    }
  }

  const pending = invitations.filter((i) => i.state === 'open');
  return (
    <>
      <button className="btn btn-p" type="button" onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={16} />
        Undang Pengguna
      </button>
      {open && (
        <section className="card invite-card" aria-label="Undang pengguna">
          <div className="card-h invite-head">
            <div>
              <h2 className="h3">Undangan lokal</h2>
              <span className="sub tiny">
                Tautan sekali pakai (72 jam) yang Anda sampaikan sendiri; pengguna hanya menetapkan
                password.
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Tutup"
              onClick={() => setOpen(false)}
            >
              <Icon name="x" size={15} />
            </button>
          </div>
          {link ? (
            <div className="card-b">
              <p>
                Tautan untuk <strong>{link.email}</strong> — tampil <strong>sekali</strong>; salin
                sekarang:
              </p>
              <pre className="invite-link" tabIndex={0}>
                {link.url}
              </pre>
              <div className="reader-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-p"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(link.url)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  <Icon name="link" size={14} />
                  {copied ? 'Tersalin' : 'Salin tautan'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setLink(null);
                    setCopied(false);
                  }}
                >
                  Undang lagi
                </button>
              </div>
            </div>
          ) : (
            <form
              className="card-b workflow-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <fieldset disabled={busy} className="workflow-fields">
                <div className="grid g2">
                  <label className="field-lbl">
                    Nama
                    <input
                      className="inp"
                      required
                      minLength={2}
                      maxLength={120}
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label className="field-lbl">
                    Email
                    <input
                      className="inp"
                      type="email"
                      required
                      maxLength={254}
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                    />
                  </label>
                  <label className="field-lbl">
                    Unit kerja
                    <input
                      className="inp"
                      required
                      minLength={2}
                      maxLength={80}
                      readOnly={!canPickUnit}
                      value={form.unit}
                      onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    />
                  </label>
                  <label className="field-lbl">
                    Role
                    <select
                      className="inp"
                      value={choice}
                      onChange={(e) => setChoice(e.target.value)}
                    >
                      <optgroup label="Role bawaan">
                        {Object.entries(ROLE_LABELS)
                          .filter(([r]) => canScopeAll || r !== 'knowledge_admin')
                          .map(([r, label]) => (
                            <option key={r} value={r}>
                              {label}
                            </option>
                          ))}
                      </optgroup>
                      {customRoles.some((c) => canScopeAll || c.baseRole !== 'knowledge_admin') && (
                        <optgroup label="Role kustom">
                          {customRoles
                            .filter((c) => canScopeAll || c.baseRole !== 'knowledge_admin')
                            .map((c) => (
                              <option key={c.id} value={`custom:${c.id}`}>
                                {c.name} · berbasis {ROLE_LABELS[c.baseRole]}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                  </label>
                </div>
                <div className="field-lbl">
                  Cakupan kategori
                  <div className="choice-grid" role="group" aria-label="Cakupan kategori">
                    {canScopeAll && (
                      <label className="choice">
                        <input
                          type="checkbox"
                          checked={form.scopeAll}
                          onChange={(e) =>
                            setForm({ ...form, scopeAll: e.target.checked, categoryIds: [] })
                          }
                        />
                        <Icon name="layers" size={13} />
                        Semua kategori
                      </label>
                    )}
                    {categories.map((c) => (
                      <label className="choice" key={c.id}>
                        <input
                          type="checkbox"
                          disabled={form.scopeAll}
                          checked={form.scopeAll || form.categoryIds.includes(c.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              categoryIds: e.target.checked
                                ? [...form.categoryIds, c.id]
                                : form.categoryIds.filter((x) => x !== c.id),
                            })
                          }
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </div>
                {error && (
                  <p role="alert" className="inline-error">
                    {error}
                  </p>
                )}
                <div className="reader-actions">
                  <button className="btn btn-p" type="submit">
                    <Icon name="link" size={15} />
                    Buat tautan undangan
                  </button>
                  <button className="btn" type="button" onClick={() => setOpen(false)}>
                    Batal
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          {invitations.length > 0 && (
            <div className="card-b">
              <h3 className="h4">Undangan</h3>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Daftar undangan">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">Nama</th>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Cakupan</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Aksi</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((i) => (
                      <tr key={i.id}>
                        <td>{i.name}</td>
                        <td>{i.email}</td>
                        <td>
                          {i.roleLabel ? (
                            <>
                              {i.roleLabel}{' '}
                              <span className="sub tiny">· {ROLE_LABELS[i.role] ?? i.role}</span>
                            </>
                          ) : (
                            (ROLE_LABELS[i.role] ?? i.role)
                          )}
                        </td>
                        <td>{i.scopeAll ? 'Semua kategori' : i.categories.join(', ') || '—'}</td>
                        <td>
                          <span className={`pill ${i.state === 'open' ? 'p-green' : 'p-grey'}`}>
                            {STATE_LABELS[i.state]}
                          </span>
                        </td>
                        <td>
                          {i.state === 'open' && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void revoke(i.id)}
                            >
                              Cabut
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sub tiny">
                {pending.length} undangan terbuka. Tautan tidak disimpan — hanya hash-nya — jadi
                tautan yang hilang berarti cabut lalu undang ulang.
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
