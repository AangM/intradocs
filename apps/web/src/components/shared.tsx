import Link from 'next/link';
import { CLASSIFICATION_LABELS, formatDate, type Classification } from '@intradocs/core';
import type { DocumentItem } from '@intradocs/db/queries';
import { Icon } from './icon';
export function PageHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1 className="h1">{title}</h1>
        <p className="sub">{subtitle}</p>
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
export function Notice({
  children,
  kind = 'info',
}: {
  children: React.ReactNode;
  kind?: 'info' | 'warn';
}) {
  return (
    <div className={`callout c-${kind}`} role="note">
      <Icon name={kind === 'warn' ? 'alert' : 'shield'} size={18} />
      <div>{children}</div>
    </div>
  );
}
export function Pending({ milestone, children }: { milestone: string; children: React.ReactNode }) {
  return (
    <Notice>
      <strong>Belum aktif · {milestone}.</strong> {children}
    </Notice>
  );
}
export function Empty({
  title = 'Belum ada dokumen',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name="folder" size={28} />
      </span>
      <h2>{title}</h2>
      <p className="sub">{children}</p>
    </div>
  );
}
export function ClassificationBadge({ value }: { value: Classification }) {
  return (
    <span
      className={`pill ${value === 'confidential' ? 'p-red' : value === 'restricted' ? 'p-amber' : value === 'internal' ? 'p-blue' : 'p-green'}`}
    >
      {value === 'restricted' || value === 'confidential' ? <Icon name="lock" size={12} /> : null}
      {CLASSIFICATION_LABELS[value]}
    </span>
  );
}
export function StatusBadge({ value }: { value: DocumentItem['status'] }) {
  const labels: Record<DocumentItem['status'], string> = {
    published: 'Published',
    in_review: 'Menunggu review',
    draft: 'Draft',
    withdrawn: 'Dicabut',
    changes_requested: 'Perlu revisi',
    rejected: 'Ditolak',
    indexing: 'Menunggu indeks',
    failed: 'Pemrosesan gagal',
    superseded: 'Versi lama',
  };
  return (
    <span
      className={`pill ${value === 'published' ? 'p-green' : ['in_review', 'indexing', 'changes_requested'].includes(value) ? 'p-amber' : ['withdrawn', 'failed', 'rejected'].includes(value) ? 'p-red' : 'p-grey'}`}
    >
      {labels[value] ?? value}
    </span>
  );
}
export const documentHref = (d: Pick<DocumentItem, 'id' | 'slug'> & { versionId?: string }) =>
  `/dokumen/${d.id}/${encodeURIComponent(d.slug)}${d.versionId ? '?version=' + d.versionId : ''}`;
export function DocumentTable({ items }: { items: DocumentItem[] }) {
  if (!items.length) return <Empty>Tidak ada hasil dalam cakupan akses dan filter saat ini.</Empty>;
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabel yang dapat digulir">
      <table>
        <thead>
          <tr>
            <th scope="col">Dokumen</th>
            <th scope="col">Kategori</th>
            <th scope="col">Klasifikasi</th>
            <th scope="col">Versi</th>
            <th scope="col">Status</th>
            <th scope="col">Diperbarui</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>
                <div className="row">
                  <span className={`ft ft-${d.format.toLowerCase()}`}>{d.format}</span>
                  <div>
                    <Link href={documentHref(d)} prefetch={false} className="document-title">
                      {d.title}
                    </Link>
                    <div className="document-owner">{d.ownerLabel}</div>
                  </div>
                </div>
              </td>
              <td className="small-cell">{d.categoryName}</td>
              <td>
                <ClassificationBadge value={d.classification} />
              </td>
              <td>
                <span className="pill p-grey">v{d.versionLabel}</span>
              </td>
              <td>
                <StatusBadge value={d.status} />
              </td>
              <td className="date-cell">{formatDate(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="row">
          <span className="logo-mark">
            <Icon name="book" size={14} />
          </span>
          <span className="c">IntraDocs · M3 · Dataset sintetis, bukan kebijakan resmi</span>
        </div>
        <Link href="/pengaturan" className="sub">
          Status fitur & privasi
        </Link>
      </div>
    </footer>
  );
}
