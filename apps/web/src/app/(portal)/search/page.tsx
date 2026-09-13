import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { getAiConfig } from '@/lib/rag';
import { SearchAiCard } from '@/components/search-ai-card';
import { searchDocuments, searchFacets } from '@intradocs/db/discovery';
import { catalogHref } from '@/components/discovery-filters';
import { parseCatalogQuery, type CatalogQuery } from '@intradocs/core/validation';
import { formatDate, formatRelative } from '@intradocs/core';
import {
  PageHeading,
  ClassificationBadge,
  Empty,
  documentHref,
  CategoryTag,
} from '@/components/shared';
import { Icon } from '@/components/icon';
import { SortSelect } from '@/components/sort-select';

const FORMAT_LABEL: Record<string, string> = {
  MD: 'Markdown',
  TXT: 'Teks',
  PDF: 'PDF',
  DOCX: 'Word (.docx)',
  XLSX: 'Excel (.xlsx)',
  HTML: 'HTML (.html)',
  PPTX: 'PowerPoint (.pptx)',
};

/** Query terms (3+ chars) wrapped in <mark>; everything stays a text node. */
function highlight(text: string, q: string) {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return text;
  const split = new RegExp(`(${terms.join('|')})`, 'gi');
  const isTerm = new RegExp(`^(?:${terms.join('|')})$`, 'i');
  return text
    .split(split)
    .map((part, i) =>
      isTerm.test(part) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
    );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={`chk ${on ? 'on' : ''}`} aria-hidden="true">
      {on && <Icon name="check" size={11} />}
    </span>
  );
}

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
  const [data, facets] = await Promise.all([
    searchDocuments(actor.id, query),
    searchFacets(actor.id, query.q),
  ]);
  // A facet is a link to the same search with one parameter changed; clicking the
  // active one clears it. No script needed, and every state has a URL.
  const withParam = (key: keyof CatalogQuery, value: string | undefined) =>
    catalogHref('/search', { ...query, [key]: value || undefined }, 1);
  const activeRecency = query.after
    ? query.after >= facets.since.days7
      ? '7'
      : query.after >= facets.since.days90
        ? '90'
        : ''
    : 'all';
  const filtered = !!(query.category || query.label || query.format || query.after || query.owner);
  return (
    <div className="search-layout">
      <aside className="search-filters" aria-label="Filter pencarian">
        <form action="/search" className="search-kw" role="search">
          <Icon name="search" size={15} />
          <input
            className="inp"
            name="q"
            defaultValue={query.q}
            maxLength={200}
            placeholder="Kata kunci…"
            aria-label="Kata kunci"
          />
        </form>
        {/* On a phone the facets fold under this label (CSS only, no JS); on a desktop the
            checkbox and label are hidden and the groups always show. */}
        <input type="checkbox" id="filters-toggle" className="filters-toggle sr-only" />
        <label htmlFor="filters-toggle" className="btn btn-sm filters-label">
          <Icon name="filter" size={14} />
          Filter{filtered ? ' · aktif' : ''}
        </label>
        <div className="filter-groups">
          <div className="row mb" style={{ justifyContent: 'space-between' }}>
            <h2 className="h3">Filter</h2>
            {filtered && (
              <Link
                className="filter-reset"
                href={catalogHref(
                  '/search',
                  {
                    ...query,
                    category: null,
                    label: undefined,
                    format: undefined,
                    after: undefined,
                    owner: undefined,
                  },
                  1,
                )}
              >
                Reset
              </Link>
            )}
          </div>
          <div className="fgroup">
            <div className="ft-l">Kategori</div>
            {facets.categories.map((c) => (
              <Link
                key={c.id}
                className="fitem"
                href={withParam('category', query.category === c.id ? undefined : c.id)}
                aria-current={query.category === c.id ? 'true' : undefined}
              >
                <Check on={query.category === c.id} /> {c.name} <span className="n">{c.n}</span>
              </Link>
            ))}
            {!facets.categories.length && (
              <p className="sub tiny">Tidak ada kategori yang cocok.</p>
            )}
          </div>
          {facets.labels.length > 0 && (
            <div className="fgroup">
              <div className="ft-l">Label</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {facets.labels.map((l) => (
                  <Link
                    key={l.name}
                    className={`tag ${query.label === l.name ? 'tag-on' : ''}`}
                    href={withParam('label', query.label === l.name ? undefined : l.name)}
                    aria-current={query.label === l.name ? 'true' : undefined}
                  >
                    {l.name} <span className="n">{l.n}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="fgroup">
            <div className="ft-l">Format berkas</div>
            {facets.formats.map((f) => (
              <Link
                key={f.format}
                className="fitem"
                href={withParam('format', query.format === f.format ? undefined : f.format)}
                aria-current={query.format === f.format ? 'true' : undefined}
              >
                <Check on={query.format === f.format} /> {FORMAT_LABEL[f.format] ?? f.format}{' '}
                <span className="n">{f.n}</span>
              </Link>
            ))}
          </div>
          <div className="fgroup">
            <div className="ft-l">Terakhir diperbarui</div>
            {(
              [
                ['7', '7 hari terakhir', facets.recency.days7, facets.since.days7],
                ['90', '90 hari terakhir', facets.recency.days90, facets.since.days90],
                ['all', 'Semua waktu', facets.recency.all, undefined],
              ] as const
            ).map(([key, label, n, after]) => (
              <Link
                key={key}
                className="fitem"
                href={withParam('after', after)}
                aria-current={activeRecency === key ? 'true' : undefined}
              >
                <Check on={activeRecency === key} /> {label} <span className="n">{n}</span>
              </Link>
            ))}
          </div>
          <div className="fgroup">
            <div className="ft-l">Status</div>
            <span className="fitem">
              <Check on /> Published <span className="n">{facets.recency.all}</span>
            </span>
            <Link className="fitem" href={`/katalog?status=mine&q=${encodeURIComponent(query.q)}`}>
              <Check on={false} /> Draft milik saya <Icon name="arrow-r" size={12} className="n" />
            </Link>
          </div>
        </div>
      </aside>

      <div className="search-results">
        <div className="row mb search-head" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1 className="h2">
              {query.q
                ? `${data.total} hasil untuk “${query.q}”`
                : `${data.total} dokumen yang boleh Anda baca`}
            </h1>
            <p className="sub" style={{ marginTop: 2 }}>
              {data.durationMs} ms · judul, ringkasan, dan isi dokumen yang boleh Anda baca
            </p>
          </div>
          <div className="row">
            <span className="sub">Urutkan:</span>
            <SortSelect
              value={query.sort}
              options={[
                [
                  'updated',
                  'Paling relevan',
                  catalogHref('/search', { ...query, sort: 'updated' }, 1),
                ],
                ['title', 'Judul A–Z', catalogHref('/search', { ...query, sort: 'title' }, 1)],
              ]}
            />
          </div>
        </div>

        {aiOn && query.q.trim() ? (
          <SearchAiCard
            key={`${query.q.trim()}|${query.category ?? ''}`}
            query={query.q.trim()}
            categoryId={query.category}
          />
        ) : (
          !query.q && (
            <p className="sub tiny mb">
              {aiOn
                ? 'Ketik pertanyaan; potongan dokumen yang relevan menurut AI tampil di atas hasil.'
                : 'Pencarian kata kunci pada judul dan isi dokumen.'}
            </p>
          )
        )}

        {data.items.length ? (
          <div className="res-list">
            {data.items.map((d) => {
              const cat = facets.categories.find((c) => c.id === d.categoryId);
              return (
                <article className="res" key={d.id}>
                  <div className="crumb">
                    <Icon name="folder" size={13} />
                    <Link href={withParam('category', d.categoryId)}>{d.categoryName}</Link>
                    <Icon name="chev-r" size={11} />
                    <span>v{d.versionLabel}</span>
                  </div>
                  <h2 className="t">
                    <Link href={documentHref(d)} prefetch={false}>
                      {d.title}
                    </Link>
                  </h2>
                  <p className="sn">{highlight(d.snippet, query.q)}</p>
                  <div className="m">
                    <span className="tag">
                      <Icon name="file" size={13} /> {FORMAT_LABEL[d.format] ?? d.format} ·{' '}
                      {Math.max(1, Math.round(d.bytes / 1024))} KB
                    </span>
                    {cat && <CategoryTag name={cat.name} color={cat.color} />}
                    {d.labels.map((t) => (
                      <Link className="tag" key={t} href={withParam('label', t)}>
                        {t}
                      </Link>
                    ))}
                    <span className="sub tiny">
                      Diperbarui{' '}
                      <time dateTime={d.updatedAt} title={formatDate(d.updatedAt)}>
                        {formatRelative(d.updatedAt)}
                      </time>{' '}
                      · v{d.versionLabel} · Pemilik: {d.ownerLabel}
                    </span>
                    <span className="ml-auto">
                      <ClassificationBadge value={d.classification} />
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="card">
            <Empty title="Tidak ada hasil yang tersedia">
              Coba kata kunci lain atau ubah filter. Hasil kosong tidak mengungkap keberadaan
              dokumen di luar hak akses Anda.
            </Empty>
          </div>
        )}
        {data.total > data.pageSize && (
          <div className="pager">
            {query.page > 1 && (
              <Link className="btn btn-sm" href={catalogHref('/search', query, query.page - 1)}>
                Sebelumnya
              </Link>
            )}
            <span className="sub tiny">
              Halaman {query.page} dari {Math.ceil(data.total / data.pageSize)}
            </span>
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
