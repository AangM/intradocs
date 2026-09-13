import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listDocuments, listCategories } from '@intradocs/db/queries';
import { parseCatalogQuery, type CatalogQuery } from '@intradocs/core/validation';
import { hasCapability, formatNumber, formatDate, formatRelative } from '@intradocs/core';
import {
  PageHeading,
  Empty,
  StatusBadge,
  ClassificationBadge,
  CategoryTag,
  documentHref,
} from '@/components/shared';
import { Icon } from '@/components/icon';
import { discoveryOptions } from '@intradocs/db/discovery';
import { catalogHref } from '@/components/discovery-filters';
import { FilterChip } from '@/components/filter-chip';

const FORMAT_LABEL: Record<string, string> = {
  MD: 'Markdown',
  TXT: 'Teks',
  PDF: 'PDF',
  DOCX: 'Word',
  XLSX: 'Excel',
};
const FT_CLASS: Record<string, string> = {
  MD: 'md',
  TXT: 'txt',
  PDF: 'pdf',
  DOCX: 'doc',
  XLSX: 'xls',
};
const FORMATS = ['MD', 'TXT', 'PDF', 'DOCX', 'XLSX'];

export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  let q: CatalogQuery;
  try {
    q = parseCatalogQuery(await searchParams);
  } catch {
    return (
      <div className="pad">
        <PageHeading
          title="Filter tidak valid"
          subtitle="Gunakan kata kunci maksimal 200 karakter dan pilihan filter yang tersedia."
        />
        <Link href="/katalog" className="btn">
          Reset filter
        </Link>
      </div>
    );
  }
  const [data, categories, options] = await Promise.all([
    listDocuments(actor.id, q),
    listCategories(actor.id),
    discoveryOptions(actor.id),
  ]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const colorOf = new Map(categories.map((c) => [c.id, c.color]));
  const withParam = (key: keyof CatalogQuery, value: string | null | undefined) =>
    catalogHref('/katalog', { ...q, [key]: value || (key === 'category' ? null : undefined) }, 1);
  const canUpload = hasCapability(actor, 'documents.upload');
  const title =
    q.view === 'favorites'
      ? 'Dokumen Favorit'
      : q.view === 'history'
        ? 'Riwayat Baca'
        : q.status === 'mine'
          ? 'Draft & Revisi Saya'
          : 'Katalog Dokumen';
  const statusLabel =
    q.status === 'published' ? 'Published' : q.status === 'mine' ? 'Draft saya' : 'Semua';
  // Numbered pages around the current one, like the mockup's "1 2 3 … 161".
  const pageNumbers = Array.from({ length: pages }, (_, i) => i + 1).filter(
    (n) => n <= 2 || n > pages - 1 || Math.abs(n - q.page) <= 1,
  );

  return (
    <div className="pad">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/katalog">Katalog</Link>
        <Icon name="chev-r" size={12} />
        <span>{q.category ? categories.find((c) => c.id === q.category)?.name : title}</span>
      </nav>
      <PageHeading
        title={title}
        subtitle={`${formatNumber(data.total)} dokumen · ${categories.length} kategori · ${options.labels.length} label aktif — sesuai hak akses Anda`}
        actions={
          canUpload ? (
            <Link className="btn btn-p" href="/unggah">
              <Icon name="upload" size={16} />
              Unggah Dokumen
            </Link>
          ) : undefined
        }
      />
      <div className="fchips">
        <form action="/katalog" className="fchip-search" role="search">
          {q.view && <input type="hidden" name="view" value={q.view} />}
          <input type="hidden" name="status" value={q.status} />
          {q.category && <input type="hidden" name="category" value={q.category} />}
          {q.label && <input type="hidden" name="label" value={q.label} />}
          {q.format && <input type="hidden" name="format" value={q.format} />}
          <Icon name="search" size={14} />
          <input
            className="inp"
            name="q"
            defaultValue={q.q}
            maxLength={200}
            placeholder="Judul atau ringkasan…"
            aria-label="Cari dokumen"
          />
        </form>
        <FilterChip
          label="Kategori"
          value={q.category ? (categories.find((c) => c.id === q.category)?.name ?? null) : null}
          clearHref={withParam('category', null)}
          options={categories.map((c) => ({
            label: c.name,
            href: withParam('category', c.id),
            active: q.category === c.id,
            count: c.documentCount,
          }))}
        />
        <FilterChip
          label="Label"
          value={q.label ?? null}
          clearHref={withParam('label', undefined)}
          options={options.labels.map((l) => ({
            label: l,
            href: withParam('label', l),
            active: q.label === l,
          }))}
        />
        <FilterChip
          label="Format"
          value={q.format ? (FORMAT_LABEL[q.format] ?? q.format) : null}
          clearHref={withParam('format', undefined)}
          options={FORMATS.map((f) => ({
            label: FORMAT_LABEL[f] ?? f,
            href: withParam('format', f),
            active: q.format === f,
          }))}
        />
        <FilterChip
          label="Pemilik"
          value={q.owner ? (options.owners.find((o) => o.id === q.owner)?.name ?? null) : null}
          clearHref={withParam('owner', undefined)}
          options={options.owners.map((o) => ({
            label: o.name,
            href: withParam('owner', o.id),
            active: q.owner === o.id,
          }))}
        />
        <FilterChip
          label="Status"
          value={statusLabel}
          options={[
            {
              label: 'Published aktif',
              href: withParam('status', 'published'),
              active: q.status === 'published',
            },
            ...(canUpload
              ? [
                  {
                    label: 'Draft saya',
                    href: withParam('status', 'mine'),
                    active: q.status === 'mine',
                  },
                ]
              : []),
            {
              label: 'Semua yang diizinkan',
              href: withParam('status', 'all'),
              active: q.status === 'all',
            },
          ]}
        />
        <FilterChip
          label="Urutkan"
          value={q.sort === 'title' ? 'Judul A–Z' : 'Terbaru'}
          options={[
            { label: 'Terbaru', href: withParam('sort', 'updated'), active: q.sort === 'updated' },
            { label: 'Judul A–Z', href: withParam('sort', 'title'), active: q.sort === 'title' },
          ]}
        />
        {(q.category || q.label || q.format || q.owner || q.q) && (
          <Link className="filter-reset" href={`/katalog${q.view ? `?view=${q.view}` : ''}`}>
            Reset
          </Link>
        )}
      </div>

      <div className="card">
        {data.items.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Tabel dokumen yang dapat digulir"
          >
            <table className="doc-table">
              <thead>
                <tr>
                  <th scope="col">Dokumen</th>
                  <th scope="col">Kategori</th>
                  <th scope="col">Label</th>
                  <th scope="col">Versi</th>
                  <th scope="col">Pemilik</th>
                  <th scope="col">Diperbarui</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Aksi</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.versionId} className={d.status === 'in_review' ? 'row-pending' : ''}>
                    <td>
                      <div className="row doc-cell">
                        <span className={`ft ft-${FT_CLASS[d.format] ?? 'txt'}`}>
                          {d.format === 'DOCX' ? 'DOC' : d.format === 'XLSX' ? 'XLS' : d.format}
                        </span>
                        <div className="doc-cell-text">
                          <Link href={documentHref(d)} prefetch={false} className="document-title">
                            {d.title}
                          </Link>
                          <div className="document-owner">
                            {FORMAT_LABEL[d.format] ?? d.format} · {Math.max(1, Math.round(d.bytes / 1024))} KB
                            {d.status !== 'published' ? ` · diunggah ${d.ownerLabel}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <CategoryTag
                        name={d.categoryName}
                        color={colorOf.get(d.categoryId) ?? 'blue'}
                      />
                    </td>
                    <td>
                      <div className="row label-cell">
                        {d.labels.slice(0, 1).map((t) => (
                          <Link
                            className="tag"
                            key={t}
                            href={withParam('label', t)}
                            prefetch={false}
                          >
                            {t}
                          </Link>
                        ))}
                        {d.labels.length > 1 && (
                          <span className="tag tag-more" title={d.labels.slice(1).join(', ')}>
                            +{d.labels.length - 1}
                          </span>
                        )}
                        {!d.labels.length && <span className="sub tiny">—</span>}
                      </div>
                    </td>
                    <td>
                      <span className="pill p-grey">v{d.versionLabel}</span>
                    </td>
                    <td className="small-cell">{d.ownerLabel}</td>
                    <td className="date-cell">
                      <time dateTime={d.updatedAt} title={formatDate(d.updatedAt)}>
                        {formatRelative(d.updatedAt)}
                      </time>
                    </td>
                    <td>
                      {d.classification === 'restricted' || d.classification === 'confidential' ? (
                        <ClassificationBadge value={d.classification} />
                      ) : (
                        <StatusBadge value={d.status} />
                      )}
                    </td>
                    <td className="actions-cell">
                      <details className="row-menu">
                        <summary aria-label={`Aksi untuk ${d.title}`}>
                          <Icon name="more" size={16} />
                        </summary>
                        <div className="fchip-menu" role="menu">
                          <Link href={documentHref(d)} prefetch={false} role="menuitem">
                            Buka dokumen
                          </Link>
                          <a href={`/api/files/${d.versionId}/markdown`} role="menuitem">
                            Unduh Markdown
                          </a>
                          <Link href={`/ai-assistant?doc=${d.id}`} prefetch={false} role="menuitem">
                            Tanya AI tentang ini
                          </Link>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Tidak ada dokumen">
            Tidak ada hasil dalam cakupan akses dan filter saat ini. Hasil kosong tidak mengungkap
            dokumen di luar hak akses Anda.
          </Empty>
        )}
        <div className="pager">
          <span>
            {data.total === 0
              ? 'Tidak ada hasil'
              : `Menampilkan ${(q.page - 1) * data.pageSize + 1}–${Math.min(q.page * data.pageSize, data.total)} dari ${formatNumber(data.total)} dokumen`}
          </span>
          {pages > 1 && (
            <div className="row pager-pages">
              {q.page > 1 && (
                <Link
                  className="btn btn-sm"
                  href={catalogHref('/katalog', q, q.page - 1)}
                  prefetch={false}
                >
                  Sebelumnya
                </Link>
              )}
              {pageNumbers.map((n, i) => (
                <span key={n} className="row" style={{ gap: 5 }}>
                  {i > 0 && n - pageNumbers[i - 1]! > 1 && <span className="sub">…</span>}
                  <Link
                    className={`btn btn-sm ${n === q.page ? 'btn-p' : ''}`}
                    href={catalogHref('/katalog', q, n)}
                    prefetch={false}
                    aria-current={n === q.page ? 'page' : undefined}
                  >
                    {n}
                  </Link>
                </span>
              ))}
              {q.page < pages && (
                <Link
                  className="btn btn-sm"
                  href={catalogHref('/katalog', q, q.page + 1)}
                  prefetch={false}
                >
                  Berikutnya
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="sub tiny mt20">
        Katalog memfilter metadata dan versi berizin; gunakan Pencarian untuk kata di dalam isi.
        {q.status === 'all'
          ? ' Tampilan ini dapat menyertakan draft milik Anda atau versi historis yang masih diizinkan; status tidak sama dengan klasifikasi.'
          : ''}
      </p>
    </div>
  );
}
