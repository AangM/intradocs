export class InputError extends Error {}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new InputError('ID tidak valid.');
  return value.toLowerCase();
}
export type CatalogQuery = {
  q: string;
  category: string | null;
  page: number;
  status: 'published' | 'mine' | 'all';
  sort: 'updated' | 'title';
  label?: string;
  format?: string;
  owner?: string;
  after?: string;
  view?: 'favorites' | 'history';
};
export function parseCatalogQuery(
  input: Record<string, string | string[] | undefined>,
): CatalogQuery {
  const scalar = (key: string) => {
    const v = input[key];
    if (Array.isArray(v)) throw new InputError('Parameter berulang tidak didukung.');
    return v;
  };
  const q = (scalar('q') ?? '').trim();
  if (q.length > 200 || /[\u0000-\u001f]/.test(q))
    throw new InputError('Pencarian maksimal 200 karakter tanpa control character.');
  const category = scalar('category') ? parseUuid(scalar('category')) : null;
  const raw = scalar('page') ?? '1';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 10000)
    throw new InputError('Halaman tidak valid.');
  const status = scalar('status') ?? 'published';
  const sort = scalar('sort') ?? 'updated';
  if (!['published', 'mine', 'all'].includes(status) || !['updated', 'title'].includes(sort))
    throw new InputError('Filter tidak valid.');
  const label = scalar('label'),
    format = scalar('format'),
    owner = scalar('owner'),
    after = scalar('after'),
    view = scalar('view');
  if (label && (label.length > 32 || /[\u0000-\u001f]/.test(label)))
    throw new InputError('Label tidak valid.');
  if (format && !['MD', 'TXT', 'PDF', 'DOCX', 'XLSX', 'HTML', 'PPTX'].includes(format))
    throw new InputError('Format tidak valid.');
  if (owner && !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new InputError('Pemilik tidak valid.');
  if (
    after &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(after) ||
      Number.isNaN(Date.parse(after)) ||
      new Date(after).toISOString().slice(0, 10) !== after)
  )
    throw new InputError('Tanggal tidak valid.');
  if (view && !['favorites', 'history'].includes(view)) throw new InputError('View tidak valid.');
  return {
    ...(label ? { label } : {}),
    ...(format ? { format } : {}),
    ...(owner ? { owner } : {}),
    ...(after ? { after } : {}),
    ...(view ? { view: view as 'favorites' | 'history' } : {}),
    q,
    category,
    page: Number(raw),
    status: status as CatalogQuery['status'],
    sort: sort as CatalogQuery['sort'],
  };
}
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function safeReturnTo(value: unknown): string {
  const fallback = '/help-center';
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\r\n\u0000]/.test(value)
  )
    return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\r\n\u0000]/.test(decoded)) return fallback;
    const u = new URL(value, 'http://localhost');
    return u.origin === 'http://localhost' &&
      !u.pathname.startsWith('/api/') &&
      !u.pathname.startsWith('/login')
      ? u.pathname + u.search
      : fallback;
  } catch {
    return fallback;
  }
}
export function assertSameOrigin(origin: string | null, expected: string): void {
  if (!origin || !sameLocalOrigin(origin, expected))
    throw new InputError('Origin request ditolak.');
}
function sameLocalOrigin(origin: string, expected: string): boolean {
  let actualUrl: URL;
  let expectedUrl: URL;
  try {
    actualUrl = new URL(origin);
    expectedUrl = new URL(expected);
  } catch {
    return false;
  }
  if (actualUrl.origin === expectedUrl.origin) return true;
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  return (
    actualUrl.protocol === 'http:' &&
    expectedUrl.protocol === 'http:' &&
    actualUrl.port === expectedUrl.port &&
    loopbackHosts.has(actualUrl.hostname) &&
    loopbackHosts.has(expectedUrl.hostname)
  );
}
export function parseStatusBody(value: unknown): { active: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Payload tidak valid.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 1 || typeof v.active !== 'boolean')
    throw new InputError('Hanya field active:boolean yang diizinkan.');
  return { active: v.active };
}
export function safeLink(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u0020\\]/.test(value) || value.startsWith('//')) return undefined;
  if (value.startsWith('/') || value.startsWith('#')) return value;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function headingSlug(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'bagian'
  );
}
