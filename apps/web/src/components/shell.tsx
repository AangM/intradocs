'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { hasCapability, initials, ROLE_LABELS, type Actor, type Capability } from '@intradocs/core';
import type { Category } from '@intradocs/db/queries';
import { Icon } from './icon';
const navigation: Array<{
  href: string;
  label: string;
  icon: string;
  capability?: Capability;
  group: 'knowledge' | 'manage';
}> = [
  { href: '/help-center', label: 'Help Center', icon: 'home', group: 'knowledge' },
  { href: '/katalog', label: 'Katalog Dokumen', icon: 'book', group: 'knowledge' },
  { href: '/katalog?view=favorites', label: 'Favorit', icon: 'star', group: 'knowledge' },
  { href: '/katalog?view=history', label: 'Riwayat baca', icon: 'clock', group: 'knowledge' },
  {
    href: '/katalog?status=mine',
    label: 'Draft saya',
    icon: 'edit',
    capability: 'documents.upload',
    group: 'knowledge',
  },
  { href: '/notifikasi', label: 'Notifikasi', icon: 'bell', group: 'knowledge' },
  { href: '/akses', label: 'Permintaan Akses', icon: 'lock', group: 'knowledge' },
  {
    href: '/feedback',
    label: 'Masukan dokumen',
    icon: 'msg',
    capability: 'documents.upload',
    group: 'knowledge',
  },
  { href: '/ai-assistant', label: 'AI Assistant', icon: 'spark', group: 'knowledge' },
  {
    href: '/unggah',
    label: 'Unggah Dokumen',
    icon: 'upload',
    capability: 'documents.upload',
    group: 'knowledge',
  },
  {
    href: '/admin/approval',
    label: 'Antrean Persetujuan',
    icon: 'check-c',
    capability: 'documents.review',
    group: 'manage',
  },
  {
    href: '/admin/kategori-label',
    label: 'Kategori & Label',
    icon: 'folder',
    capability: 'taxonomy.view',
    group: 'manage',
  },
  {
    href: '/admin/pengguna',
    label: 'Pengguna & RBAC',
    icon: 'users',
    capability: 'users.view',
    group: 'manage',
  },
  {
    href: '/admin/dashboard',
    label: 'Dashboard',
    icon: 'chart',
    capability: 'analytics.view',
    group: 'manage',
  },
  {
    href: '/admin/audit',
    label: 'Audit Log',
    icon: 'act',
    capability: 'audit.view',
    group: 'manage',
  },
];
export function Shell({
  actor,
  categories,
  aiOn = false,
  counts = {},
  children,
}: {
  actor: Actor;
  categories: Category[];
  /** Server-decided; the footer must never claim more or less than the config says. */
  aiOn?: boolean;
  /** Badge per nav href (unread notifications, pending reviews, own drafts); zero hides it. */
  counts?: Record<string, number>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const reader = pathname.startsWith('/dokumen/');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-global-search]')?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  async function signOut() {
    setSigningOut(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error();
      router.replace('/login');
      router.refresh();
    } catch {
      setError('Gagal keluar. Coba lagi.');
      setSigningOut(false);
    }
  }
  const allowed = navigation.filter((n) => !n.capability || hasCapability(actor, n.capability));
  return (
    <div className={`app live-app ${open ? 'nav-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        Lewati navigasi
      </a>
      <header className="topbar">
        {!reader && (
          <button
            className="icon-btn mobile-menu"
            aria-label="Buka navigasi"
            aria-expanded={open}
            aria-controls="side-menu"
            onClick={() => setOpen(!open)}
          >
            <Icon name="list" />
          </button>
        )}
        <Link href="/help-center" className="logo" onClick={() => setOpen(false)}>
          <span className="logo-mark">
            <Icon name="book" />
          </span>
          <span>
            IntraDocs<small>Knowledge Hub · Divisi IT</small>
          </span>
        </Link>
        <div className="spacer" />
        <form className="tsearch" action="/search" role="search">
          <button
            type="button"
            className="search-trigger"
            aria-label="Fokus pencarian"
            onClick={() =>
              document.querySelector<HTMLInputElement>('[data-global-search]')?.focus()
            }
          >
            <Icon name="search" size={16} />
          </button>
          <label className="sr-only" htmlFor="global-q">
            Cari dokumen
          </label>
          <input
            id="global-q"
            data-global-search
            name="q"
            placeholder="Cari dokumen…"
            maxLength={200}
          />
          <kbd className="kbd">⌘K</kbd>
        </form>
        <div className="spacer" />
        {aiOn && (
          <Link
            href="/ai-assistant"
            className={`btn btn-sm topbar-ask ${pathname === '/ai-assistant' ? 'btn-on' : ''}`}
            prefetch={false}
            aria-label="Tanya AI"
            onClick={() => setOpen(false)}
          >
            <Icon name="spark" size={15} />
            <span>Tanya AI</span>
          </Link>
        )}
        <Link
          href="/notifikasi"
          className="icon-btn topbar-bell"
          aria-label={
            (counts['/notifikasi'] ?? 0) > 0
              ? `Notifikasi, ${counts['/notifikasi']} belum dibaca`
              : 'Notifikasi'
          }
          prefetch={false}
        >
          <Icon name="bell" size={18} />
          {(counts['/notifikasi'] ?? 0) > 0 && <span className="dot-badge" />}
        </Link>
        <details className="account-menu">
          <summary aria-label={`Akun: ${actor.name}`}>
            <span className="avatar">{initials(actor.name)}</span>
            <span className="who-text">
              <span className="nm">{actor.name}</span>
              <span className="rl">{ROLE_LABELS[actor.role]}</span>
            </span>
            <Icon name="chev-d" size={14} className="account-caret" />
          </summary>
          <div className="account-panel" role="menu">
            <div className="account-head">
              <strong>{actor.name}</strong>
              <span className="sub tiny">
                {ROLE_LABELS[actor.role]} · {actor.unit}
              </span>
              <span className="pill p-amber">Lokal · data sintetis</span>
            </div>
            <Link
              href="/pengaturan"
              role="menuitem"
              prefetch={false}
              onClick={() => setOpen(false)}
            >
              <Icon name="settings" size={15} /> Pengaturan & status fitur
            </Link>
            <Link href="/katalog?view=favorites" role="menuitem" prefetch={false}>
              <Icon name="star" size={15} /> Dokumen favorit
            </Link>
            <button type="button" role="menuitem" onClick={signOut} disabled={signingOut}>
              <Icon name="lock" size={15} /> {signingOut ? 'Keluar…' : 'Keluar'}
            </button>
          </div>
        </details>
      </header>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div className="body">
        {!reader && (
          <aside className="side" id="side-menu">
            <nav aria-label="Menu portal">
              {(['knowledge', 'manage'] as const).map((group) => {
                const links = allowed.filter((n) => n.group === group);
                return links.length ? (
                  <div key={group}>
                    <div className="side-lbl">
                      {group === 'knowledge' ? 'Knowledge Base' : 'Manajemen'}
                    </div>
                    {links.map((n) => (
                      <Link
                        key={n.href}
                        href={n.href}
                        prefetch={false}
                        aria-current={pathname === n.href ? 'page' : undefined}
                        className={`nav-i ${pathname === n.href ? 'on' : ''}`}
                        onClick={() => setOpen(false)}
                      >
                        <Icon name={n.icon} size={17} />
                        {n.label}
                        {(counts[n.href] ?? 0) > 0 && (
                          <span
                            className={`cnt ${n.href === '/admin/approval' ? '' : 'grey'}`}
                            aria-label={`${counts[n.href]} item`}
                          >
                            {counts[n.href]}
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                ) : null;
              })}
              <div className="side-lbl">Kategori</div>
              {categories.map((c) => (
                <Link
                  key={c.id}
                  href={`/katalog?category=${c.id}`}
                  prefetch={false}
                  className="nav-i category-nav"
                  onClick={() => setOpen(false)}
                >
                  <span className={`category-dot tone-${c.color}`} />
                  <span>{c.name}</span>
                </Link>
              ))}
              <div className="sidebar-bottom">
                <Link
                  href="/pengaturan"
                  className={`nav-i ${pathname === '/pengaturan' ? 'on' : ''}`}
                >
                  <Icon name="settings" size={17} />
                  Pengaturan
                </Link>
                <div className="local-note">
                  <span className="status-dot" />
                  Development lokal
                  <br />
                  <span>{aiOn ? 'AI lokal' : 'AI off'} · tanpa data Telkom nyata</span>
                </div>
              </div>
            </nav>
          </aside>
        )}
        <main id="main-content" className={reader ? 'reader-area' : 'main'} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
