import { UserAssignment } from '@/components/user-assignment';
import { listCategories } from '@intradocs/db/queries';
import { requireActor } from '@/lib/session';
import { listUsers } from '@intradocs/db/queries';
import { ROLES, ROLE_LABELS, hasCapability, initials, type Role } from '@intradocs/core';
import { PageHeading, Notice } from '@/components/shared';
import { Icon } from '@/components/icon';
import { UserStatus } from '@/components/user-status';
import { InviteUser } from '@/components/invite-user';
import { listInvitations } from '@intradocs/db/invitations';
const detail: Record<Role, { icon: string; color: string; description: string }> = {
  super_admin: {
    icon: 'shield',
    color: 'red',
    description: 'Mengelola akun. Akses dokumen sensitif tetap membutuhkan grant eksplisit.',
  },
  knowledge_admin: {
    icon: 'check-c',
    color: 'amber',
    description: 'Mengelola knowledge sesuai scope. Pengguna dibatasi pada unit kerja.',
  },
  reviewer: {
    icon: 'eye',
    color: 'violet',
    description: 'Membaca pengajuan yang ditugaskan dan berada dalam scope kategori.',
  },
  contributor: {
    icon: 'edit',
    color: 'blue',
    description:
      'Membaca dokumen yang diizinkan dan draft sendiri. Upload/revisi aktif; publikasi membutuhkan review.',
  },
  viewer: {
    icon: 'book',
    color: 'green',
    description: 'Membaca Published Publik/Internal sesuai scope kategori.',
  },
};
export default async function Users() {
  const actor = await requireActor('users.view');
  const categories = await listCategories(actor.id);
  const users = await listUsers(actor);
  const manage = hasCapability(actor, 'users.manage');
  const invitations = await listInvitations(actor.id);
  return (
    <div className="pad">
      <PageHeading
        title="Pengguna & Kontrol Akses (RBAC)"
        subtitle={`${users.filter((u) => u.active).length} pengguna aktif terlihat · 5 role bawaan · identitas lokal`}
        actions={
          <>
            <button
              className="btn"
              disabled
              title="SSO/AD berada di luar rilis lokal ini: butuh IdP organisasi dan persetujuan security."
            >
              <Icon name="refresh" size={16} />
              Sinkron SSO
            </button>
          </>
        }
      />
      <div className="invite-row">
        <InviteUser
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          invitations={invitations}
          defaultUnit={actor.unit}
          canPickUnit={actor.role === 'super_admin'}
          canScopeAll={actor.role === 'super_admin'}
        />
      </div>
      <div className="grid g3 rbac-cards mb">
        {ROLES.map((role) => (
          <div key={role} className={`role-card tone-${detail[role].color}`}>
            <div className="rt">
              <span className="ft" style={{ background: 'var(--tone)' }}>
                <Icon name={detail[role].icon} size={16} />
              </span>
              <div>
                <strong>{ROLE_LABELS[role]}</strong>
                <p className="role-count">
                  {users.filter((u) => u.role === role).length} pengguna dalam cakupan Anda
                </p>
              </div>
            </div>
            <p className="rd">{detail[role].description}</p>
          </div>
        ))}
        <div className="role-card role-pending">
          <div>
            <Icon name="plus" size={23} style={{ margin: '0 auto 8px' }} />
            <strong>Role kustom</strong>
            <span className="sub tiny">Di luar rilis ini</span>
          </div>
        </div>
      </div>
      <Notice>
        <strong>Scope + klasifikasi tetap berlaku.</strong> Bahkan Super Admin tidak otomatis
        membaca Terbatas/Rahasia. Matriks berikut menunjukkan akses yang benar-benar diberlakukan;
        bukan janji fitur yang belum tersedia.
      </Notice>
      <section className="card mb">
        <div className="card-h">
          <Icon name="lock" />
          <h2 className="h3">Matriks izin</h2>
        </div>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Tabel yang dapat digulir"
        >
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Kemampuan</th>
                {ROLES.map((r) => (
                  <th scope="col" key={r}>
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Baca Publik & Internal</td>
                {ROLES.map((r) => (
                  <td key={r} className="permission-limited">
                    Sesuai scope
                  </td>
                ))}
              </tr>
              <tr>
                <td>Baca Terbatas / Rahasia</td>
                {ROLES.map((r) => (
                  <td key={r} className={r === 'viewer' ? 'permission-no' : 'permission-limited'}>
                    {r === 'viewer' ? 'Tidak' : 'Scope + grant'}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Baca draft</td>
                {ROLES.map((r) => (
                  <td key={r} className="permission-limited">
                    Pemilik / penugasan
                  </td>
                ))}
              </tr>
              <tr>
                <td>Melihat pengguna</td>
                {ROLES.map((r) => (
                  <td
                    key={r}
                    className={
                      r === 'super_admin'
                        ? 'permission-yes'
                        : r === 'knowledge_admin'
                          ? 'permission-limited'
                          : 'permission-no'
                    }
                  >
                    {r === 'super_admin'
                      ? 'Ya'
                      : r === 'knowledge_admin'
                        ? 'Unit sendiri'
                        : 'Tidak'}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Aktifkan / nonaktifkan akun</td>
                {ROLES.map((r) => (
                  <td key={r} className={r === 'super_admin' ? 'permission-yes' : 'permission-no'}>
                    {r === 'super_admin' ? 'Selain diri sendiri' : 'Tidak'}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Upload / review</td>
                <td>Dalam scope / ditugaskan</td>
                <td>Dalam scope / ditugaskan</td>
                <td>Dalam scope / ditugaskan</td>
                <td>Milik sendiri / tidak</td>
                <td>Tidak / tidak</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="card user-table">
        <div className="card-h">
          <Icon name="users" />
          <h2 className="h3">Pengguna dalam cakupan Anda</h2>
          <span className="pill p-grey">{users.length} akun</span>
        </div>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Tabel yang dapat digulir"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Pengguna</th>
                <th scope="col">Role</th>
                <th scope="col">Unit</th>
                <th scope="col">Scope kategori</th>
                <th scope="col">Status</th>
                <th scope="col">Penugasan role & scope</th>
                {manage && <th scope="col">Aktivasi</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="who">
                      <span className="avatar">{initials(u.name)}</span>
                      <div>
                        <strong>{u.name}</strong>
                        <p className="document-owner">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="pill p-blue">{ROLE_LABELS[u.role]}</span>
                  </td>
                  <td className="small-cell">{u.unit}</td>
                  <td>
                    <div className="scope-list">
                      {u.scopeAll ? (
                        <span className="tag">Semua kategori</span>
                      ) : (
                        u.categories.map((c) => (
                          <span className="tag" key={c}>
                            {c}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${u.active ? 'p-green' : 'p-grey'}`}>
                      {u.active ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </td>
                  <td>
                    <UserAssignment
                      id={u.id}
                      initialRole={u.role}
                      scopeAll={u.scopeAll}
                      categoryIds={u.categoryIds}
                      categories={categories}
                      superAdmin={actor.role === 'super_admin'}
                      own={actor.id === u.id}
                    />
                  </td>
                  {manage && (
                    <td>
                      <UserStatus id={u.id} active={u.active} own={u.id === actor.id} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="sub tiny mt20">
        Menonaktifkan akun memblokir pembacaan data di database dan mencabut session. Akun sendiri
        tidak dapat dinonaktifkan; karena pelaku harus admin aktif, tindakan ini tidak dapat
        menghapus admin aktif terakhir.
      </p>
    </div>
  );
}
