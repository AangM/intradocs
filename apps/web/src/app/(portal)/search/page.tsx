import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { getAiConfig } from '@/lib/rag';
import { SearchAiCard } from '@/components/search-ai-card';
import { listCategories } from '@intradocs/db/queries';
import { searchDocuments, discoveryOptions } from '@intradocs/db/discovery';
import { DiscoveryFilters, catalogHref } from '@/components/discovery-filters';
import { parseCatalogQuery, type CatalogQuery } from '@intradocs/core/validation';
import { PageHeading, ClassificationBadge, Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
export default async function Search({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  let query: CatalogQuery;
  try {
    query = { ...parseCatalogQuery(await searchParams), status: 'published' };
  } catch {
    return (
      <div className="pad">
        <PageHeading title="Pencarian tidak valid" subtitle="Kata kunci maksimal 200 karakter." />
        <Link className="btn" href="/search">
          Ulangi pencarian
        </Link>
      </div>
    );
  }
  const aiConfig = getAiConfig();
  const aiOn = aiConfig.retrieval === 'weknora-local' && Boolean(aiConfig.weknora);
  const [categories, data, options] = await Promise.all([
    listCategories(actor.id),
    searchDocuments(actor.id, query),
    discoveryOptions(actor.id),
  ]);
  return (
    <div className="search-layout">
      <aside className="search-filters">
        <h2 className="filter-title">FILTER PENCARIAN</h2>
        <form action="/search">
          <div className="filter-group">
            <label htmlFor="search-q">Kata kunci</label>
            <input className="inp" id="search-q" name="q" defaultValue={query.q} maxLength={200} />
          </div>
          <div className="filter-group">
            <label htmlFor="search-cat">Kategori</label>
            <select
              className="inp"
              id="search-cat"
              name="category"
              defaultValue={query.category ?? ''}
            >
              <option value="">Semua kategori</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <DiscoveryFilters query={query} options={options} />
          <button className="btn btn-p" type="submit">
            <Icon name="filter" size={15} />
            Terapkan
          </button>
        </form>
        <p className="sub tiny mt20">
          Hanya dokumen published, tidak kedaluwarsa, dan sesuai akses akun yang ditampilkan.
        </p>
      </aside>
      <div className="search-results">
        <PageHeading
          title={query.q ? `Hasil untuk “${query.q}”` : 'Cari pengetahuan tim'}
          subtitle={`${data.total} hasil · pencarian lexical pada judul, metadata, dan isi · ${data.durationMs} ms di server`}
        />
        {aiOn && query.q.trim() ? (
          <SearchAiCard
            key={`${query.q.trim()}|${query.category ?? ''}`}
            query={query.q.trim()}
            categoryId={query.category}
          />
        ) : (
          <p className="sub tiny mb">
            {aiOn
              ? 'Ketik pertanyaan untuk melihat potongan dokumen yang relevan menurut AI di atas hasil lexical.'
              : 'AI belum diaktifkan pada instalasi ini; hasil di bawah adalah pencarian lexical. Tidak ada dokumen di luar hak akses yang ditampilkan, termasuk judulnya.'}
          </p>
        )}
        <div className="card">
          {data.items.length ? (
            data.items.map((d) => (
              <article className="search-result" key={d.id}>
                <div className="row">
                  <span className={`ft ft-${d.format.toLowerCase()}`}>{d.format}</span>
                  <span className="sub tiny">{d.categoryName}</span>
                  <span className="pill p-grey">v{d.versionLabel}</span>
                  <ClassificationBadge value={d.classification} />
                </div>
                <h2>
                  <Link href={documentHref(d)} prefetch={false}>
                    {d.title}
                  </Link>
                </h2>
                <p>{d.snippet}</p>
                <div className="row mt20">
                  {d.labels.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                  <span className="sub tiny">Pemilik: {d.ownerLabel}</span>
                </div>
              </article>
            ))
          ) : (
            <Empty title="Tidak ada hasil yang tersedia">
              Coba kata kunci lain atau ubah filter. Hasil kosong tidak mengungkap keberadaan
              dokumen di luar hak akses Anda.
            </Empty>
          )}
        </div>
        {data.total > data.pageSize && (
          <div className="pager">
            {query.page > 1 && (
              <Link className="btn btn-sm" href={catalogHref('/search', query, query.page - 1)}>
                Sebelumnya
              </Link>
            )}
            {query.page * data.pageSize < data.total && (
              <Link className="btn btn-sm" href={catalogHref('/search', query, query.page + 1)}>
                Berikutnya
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
