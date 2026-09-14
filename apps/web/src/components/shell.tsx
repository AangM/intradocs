'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasCapability, initials, ROLE_LABELS, type Actor, type Capability } from '@intradocs/core';
import type { Category } from '@intradocs/db/queries';
import { Icon } from './icon';
import { Toaster, toast } from './toast';
import { NOTIFICATION_KINDS, type NotificationItem } from './notification-kinds';
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
// The desktop rail state lives in localStorage and is read through an external store,
// so the server renders expanded, the client corrects itself on hydration, and no
// effect has to set state. Storage may be unavailable (private mode): then the rail
// is simply not remembered.
const SIDE_KEY = 'intradocs.side';
const SIDE_EVENT = 'intradocs:side';
function readSide(): boolean {
  try {
    return window.localStorage.getItem(SIDE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}
function writeSide(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Not remembered; the event below still flips it for this page.
  }
  window.dispatchEvent(new Event(SIDE_EVENT));
}
function subscribeNothing() {
  return () => {};
}
function readMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
function subscribeSide(onChange: () => void) {
  window.addEventListener(SIDE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SIDE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
export function Shell({
  actor,
  categories,
  aiOn = false,
  counts = {},
  recent = [],
  children,
}: {
  actor: Actor;
  categories: Category[];
  /** Server-decided; the footer must never claim more or less than the config says. */
  aiOn?: boolean;
  /** Badge per nav href (unread notifications, pending reviews, own drafts); zero hides it. */
  counts?: Record<string, number>;
  /** The newest few notifications, for the bell popover; the page has the full list. */
  recent?: NotificationItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  // Two sidebar states: `open` is the phone drawer (closed on navigation, Escape or the
  // backdrop); `collapsed` is the desktop rail, remembered per browser.
  const [open, setOpen] = useState(false);
  const collapsed = useSyncExternalStore(subscribeSide, readSide, () => false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const [markingAll, setMarkingAll] = useState(false);
  // The shortcut hint names the key the person actually has; the server renders the
  // Windows/Linux form and a Mac swaps it in on hydration.
  const mac = useSyncExternalStore(subscribeNothing, readMac, () => false);
  const reader = pathname.startsWith('/dokumen/');
  const unread = counts['/notifikasi'] ?? 0;
  // Closes the bell and account popovers on navigation, the way a menu is expected to.
  useEffect(() => {
    document
      .querySelectorAll<HTMLDetailsElement>('details.bell-menu[open], details.account-menu[open]')
      .forEach((d) => d.removeAttribute('open'));
  }, [pathname]);
  async function markAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      const r = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) throw new Error();
      toast('Semua notifikasi ditandai dibaca');
      router.refresh();
    } catch {
      toast('Gagal menandai notifikasi', 'error');
    } finally {
      setMarkingAll(false);
    }
  }
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
  function toggleSide() {
    if (window.matchMedia('(max-width: 720px)').matches) {
      setOpen((v) => !v);
      return;
    }
    writeSide(!collapsed);
  }
  // A nav entry is "on" when its path matches and every query parameter it names is
  // present; the plain catalogue entry is on only when no view/status/category is set,
  // so "Favorit" and "Draft saya" do not light up "Katalog Dokumen" as well.
  function isOn(href: string): boolean {
    const [path, query = ''] = href.split('?');
    if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
    if (query) return [...new URLSearchParams(query)].every(([k, v]) => params.get(k) === v);
    if (path === '/katalog')
      return !params.has('view') && !params.has('status') && !params.has('category');
    return true;
  }
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
    <div
      className={`app live-app ${open ? 'nav-open' : ''} ${collapsed && !reader ? 'side-collapsed' : ''}`}
    >
      <a className="skip-link" href="#main-content">
        Lewati navigasi
      </a>
      <header className="topbar">
        {!reader && (
          <button
            className="icon-btn side-toggle"
            aria-label={open ? 'Tutup menu' : collapsed ? 'Tampilkan menu' : 'Sembunyikan menu'}
            title={collapsed ? 'Tampilkan menu' : 'Sembunyikan menu'}
            aria-expanded={open}
            aria-controls="side-menu"
            onClick={toggleSide}
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
          <kbd className="kbd" aria-hidden="true">
            {mac ? '⌘ K' : 'Ctrl K'}
          </kbd>
        </form>
        <div className="spacer" />
        {aiOn && (
          <Link
            href="/ai-assistant"
            className={`btn btn-sm topbar-ask ${pathname === '/ai-assistant' ? 'btn-on' : ''} ${pathname === '/help-center' ? 'compact' : ''}`}
            prefetch={false}
            aria-label="Tanya AI"
            title="Tanya AI"
            onClick={() => setOpen(false)}
          >
            <Icon name="spark" size={15} />
            <span>Tanya AI</span>
          </Link>
        )}
        <details className="bell-menu">
          <summary
            className="icon-btn topbar-bell"
            aria-label={unread > 0 ? `Notifikasi, ${unread} belum dibaca` : 'Notifikasi'}
          >
            <Icon name="bell" size={18} />
            {unread > 0 && <span className="dot-badge" />}
          </summary>
          <div className="bell-panel" role="group" aria-label="Notifikasi terbaru">
            <div className="bell-head">
              <span>
                Notifikasi
                {unread > 0 && <span className="pill p-blue">{unread} baru</span>}
              </span>
              {unread > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={markingAll}
                  onClick={() => void markAllRead()}
                >
                  <Icon name="check" size={13} />
                  Tandai semua
                </button>
              )}
            </div>
            {recent.length ? (
              <ul className="bell-list">
                {recent.map((n) => {
                  const kind = NOTIFICATION_KINDS[n.kind] ?? NOTIFICATION_KINDS.default!;
                  return (
                    <li key={n.id} className={n.read ? '' : 'unread'}>
                      <Link
                        href={`/dokumen/${n.documentId}/${encodeURIComponent(n.slug)}?version=${n.versionId}`}
                        prefetch={false}
                      >
                        <span className={`nt-ic ${kind.tone}`}>
                          <Icon name={kind.icon} size={14} />
                        </span>
                        <span>
                          <span className="nt-t">{n.title}</span>
                          <span className="nt-m">
                            {kind.label} · {n.when}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="bell-empty">Belum ada notifikasi.</p>
            )}
            <div className="bell-foot">
              <Link href="/notifikasi" prefetch={false}>
                Lihat semua notifikasi
              </Link>
            </div>
          </div>
        </details>
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
      <Toaster />
      <div className="body">
        {!reader && open && (
          <button
            type="button"
            className="side-backdrop"
            aria-label="Tutup menu"
            onClick={() => setOpen(false)}
          />
        )}
        {!reader && (
          <aside className="side" id="side-menu">
            <div className="side-head">
              <span className="side-lbl">Menu</span>
              <button
                type="button"
                className="icon-btn side-close"
                aria-label="Tutup menu"
                onClick={() => setOpen(false)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
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
                        aria-current={isOn(n.href) ? 'page' : undefined}
                        className={`nav-i ${isOn(n.href) ? 'on' : ''}`}
                        title={collapsed ? n.label : undefined}
                        onClick={() => setOpen(false)}
                      >
                        <Icon name={n.icon} size={17} />
                        <span className="nav-lbl">{n.label}</span>
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
                  className={`nav-i category-nav ${isOn(`/katalog?category=${c.id}`) ? 'on' : ''}`}
                  aria-current={isOn(`/katalog?category=${c.id}`) ? 'page' : undefined}
                  title={collapsed ? c.name : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className={`category-dot tone-${c.color}`} />
                  <span className="nav-lbl">{c.name}</span>
                </Link>
              ))}
              <div className="sidebar-bottom">
                <Link
                  href="/pengaturan"
                  className={`nav-i ${pathname === '/pengaturan' ? 'on' : ''}`}
                  title={collapsed ? 'Pengaturan' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <Icon name="settings" size={17} />
                  <span className="nav-lbl">Pengaturan</span>
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
        <main id="main-content" className={reader ? 'reader-area' : 'main'} tabIndex={0}>
          {children}
        </main>
      </div>
    </div>
  );
}
