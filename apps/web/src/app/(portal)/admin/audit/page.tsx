import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listAudit } from '@intradocs/db/queries';
import { PageHeading, Empty } from '@/components/shared';
import { Icon } from '@/components/icon';
import { AUDIT_ACTIONS, auditLabel, parseAuditFilter } from '@intradocs/core/audit-export';

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(iso));
}

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor('audit.view');
  const params = await searchParams;
  const pick = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : null);
  // The filter is the export's: the same range and action feed the file, so what the
  // page shows and what the file holds never disagree. A bad value falls back to the
  // default 30 days rather than failing the page.
  let filter;
  let filterError = '';
  try {
    filter = parseAuditFilter({ from: pick('from'), to: pick('to'), action: pick('action') });
  } catch (e) {
    filterError = e instanceof Error ? e.message : 'Filter tidak valid.';
    filter = parseAuditFilter({});
  }
  const events = await listAudit(actor, filter);
  const fromDay = filter.from.toISOString().slice(0, 10);
  const toDay = filter.to.toISOString().slice(0, 10);
  const query = new URLSearchParams({ from: fromDay, to: toDay });
  if (filter.action) query.set('action', filter.action);
  return (
    <div className="pad">
      <PageHeading
        title="Audit Log"
        subtitle="Siapa melakukan apa, kapan — 100 aktivitas terbaru dalam rentang dan cakupan Anda."
        actions={
          <div className="row">
            <a className="btn" href={`/api/reports/audit?${query}&format=csv`} download>
              <Icon name="download" size={14} />
              Ekspor CSV
            </a>
            <a className="btn" href={`/api/reports/audit?${query}&format=jsonl`} download>
              <Icon name="download" size={14} />
              JSON Lines
            </a>
          </div>
        }
      />
      <form method="get" className="card card-b audit-filter" aria-label="Filter audit">
        <label>
          Dari
          <input className="inp" type="date" name="from" defaultValue={fromDay} max={toDay} />
        </label>
        <label>
          Sampai
          <input className="inp" type="date" name="to" defaultValue={toDay} />
        </label>
        <label>
          Aktivitas
          <select className="inp" name="action" defaultValue={filter.action ?? ''}>
            <option value="">Semua aktivitas</option>
            {Object.entries(AUDIT_ACTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.text}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-p" type="submit">
          Terapkan
        </button>
        {filterError && (
          <p role="alert" className="inline-error">
            {filterError} Menampilkan 30 hari terakhir.
          </p>
        )}
      </form>
      <div className="card">
        {events.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Tabel audit yang dapat digulir"
          >
            <table className="tbl audit-table">
              <thead>
                <tr>
                  <th scope="col">Aktivitas</th>
                  <th scope="col">Oleh</th>
                  <th scope="col">Objek</th>
                  <th scope="col">Waktu</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const label = auditLabel(e.action);
                  return (
                    <tr key={`${e.id}-${i}`}>
                      <td>
                        <span className={`audit-action tone-${label.tone}`}>
                          <span className="audit-ic">
                            <Icon name={label.icon} size={14} />
                          </span>
                          {label.text}
                        </span>
                      </td>
                      <td>{e.actorName ?? <span className="sub">Pengguna di luar scope</span>}</td>
                      <td>
                        {e.documentTitle && e.documentHref ? (
                          <Link href={e.documentHref}>{e.documentTitle}</Link>
                        ) : e.subjectName ? (
                          <span>{e.subjectName}</span>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td className="sub">{formatWhen(e.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Tidak ada event pada rentang ini">
            Perlebar rentang tanggal atau pilih aktivitas lain. Membuka dokumen atau mengunduh
            Markdown menghasilkan event akses.
          </Empty>
        )}
      </div>
      <p className="sub tiny mt20">
        Setiap baris adalah permintaan yang telah lolos otorisasi. Objek hanya ditampilkan bila Anda
        sendiri boleh membacanya; nama pengguna hanya bila profilnya dalam scope Anda. Ekspor memuat
        seluruh rentang (maksimal satu tahun, 50.000 baris) dengan aturan yang sama, dan ekspor itu
        sendiri tercatat sebagai event.
      </p>
    </div>
  );
}
