import type { CatalogQuery } from '@intradocs/core/validation';
export function catalogHref(route: string, q: CatalogQuery, page: number) {
  const params = new URLSearchParams({
    q: q.q,
    status: q.status,
    sort: q.sort,
    page: String(page),
  });
  for (const k of ['category', 'label', 'format', 'owner', 'after', 'view'] as const)
    if (q[k]) params.set(k, q[k]!);
  return `${route}?${params}`;
}
export function DiscoveryFilters({
  query: q,
  options,
  includeSort = true,
}: {
  query: CatalogQuery;
  options: { labels: string[]; owners: { id: string; name: string }[] };
  includeSort?: boolean;
}) {
  return (
    <>
      <label>
        Label
        <select className="inp" name="label" defaultValue={q.label ?? ''}>
          <option value="">Semua label</option>
          {options.labels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Format
        <select className="inp" name="format" defaultValue={q.format ?? ''}>
          <option value="">Semua format</option>
          {['MD', 'TXT', 'PDF', 'DOCX', 'XLSX'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
      <label>
        Pemilik
        <select className="inp" name="owner" defaultValue={q.owner ?? ''}>
          <option value="">Semua pemilik</option>
          {options.owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sejak tanggal
        <input className="inp" type="date" name="after" defaultValue={q.after ?? ''} />
      </label>
      {includeSort && (
        <label>
          Urutkan
          <select className="inp" name="sort" defaultValue={q.sort}>
            <option value="updated">Relevansi / terbaru</option>
            <option value="title">Judul A–Z</option>
          </select>
        </label>
      )}
    </>
  );
}
