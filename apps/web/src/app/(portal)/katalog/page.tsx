import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listDocuments, listCategories } from '@intradocs/db/queries';
import { parseCatalogQuery, type CatalogQuery } from '@intradocs/core/validation';
import { hasCapability, formatNumber } from '@intradocs/core';
import { PageHeading, DocumentTable, Notice } from '@/components/shared';
import { Icon } from '@/components/icon';
import { discoveryOptions } from '@intradocs/db/discovery';
import { DiscoveryFilters, catalogHref } from '@/components/discovery-filters';
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
  return (
    <div className="pad">
      <PageHeading
        title={
          q.view === 'favorites'
            ? 'Dokumen Favorit'
            : q.view === 'history'
              ? 'Riwayat Baca'
              : q.status === 'mine'
                ? 'Draft & Revisi Saya'
                : 'Katalog Dokumen'
        }
        subtitle={`${formatNumber(data.total)} dokumen sesuai filter dan hak akses Anda`}
        actions={
          hasCapability(actor, 'documents.upload') ? (
            <Link className="btn btn-p" href="/unggah">
              <Icon name="upload" size={16} />
              Unggah Dokumen
            </Link>
          ) : undefined
        }
      />
      <Notice>
        Katalog memfilter metadata dan versi berizin. Gunakan Pencarian untuk menemukan kata di
        dalam isi. Draft/revisi belum dipublikasikan dipisahkan dari versi aktif.
      </Notice>
      <form className="catalog-filters" action="/katalog">
        {q.view && <input type="hidden" name="view" value={q.view} />}
        <label className="search-field">
          Cari dokumen
          <input
            className="inp"
            name="q"
            defaultValue={q.q}
            maxLength={200}
            placeholder="Judul atau ringkasan dokumen…"
          />
        </label>
        <label>
          Kategori
          <select className="inp" name="category" defaultValue={q.category ?? ''}>
            <option value="">Semua kategori</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select className="inp" name="status" defaultValue={q.status}>
            <option value="published">Published aktif</option>
            {hasCapability(actor, 'documents.upload') && <option value="mine">Draft saya</option>}
            <option value="all">Semua yang diizinkan</option>
          </select>
        </label>
        <label>
          Urutkan
          <select className="inp" name="sort" defaultValue={q.sort}>
            <option value="updated">Terbaru</option>
            <option value="title">Judul A–Z</option>
          </select>
        </label>
        <DiscoveryFilters query={q} options={options} includeSort={false} />
        <button className="btn" type="submit">
          <Icon name="filter" size={16} />
          Terapkan
        </button>
      </form>
      <div className="card">
        <DocumentTable items={data.items} />
        <div className="pager">
          <span>
            {data.total === 0
              ? 'Tidak ada hasil'
              : `Halaman ${q.page} dari ${pages} · ${data.total} dokumen`}
          </span>
          <div className="row">
            {q.page > 1 && (
              <Link
                className="btn btn-sm"
                href={catalogHref('/katalog', q, q.page - 1)}
                prefetch={false}
              >
                Sebelumnya
              </Link>
            )}
            {q.page < pages && (
              <Link
                className="btn btn-sm"
                href={catalogHref('/katalog', q, q.page + 1)}
                prefetch={false}
              >
                Berikutnya <Icon name="chev-r" size={13} />
              </Link>
            )}
          </div>
        </div>
      </div>
      {q.status === 'all' && (
        <p className="sub tiny mt20">
          Tampilan ini dapat menyertakan draft milik Anda atau versi historis yang masih diizinkan.
          Status tidak sama dengan klasifikasi.
        </p>
      )}
    </div>
  );
}
