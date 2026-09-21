import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { dashboardData } from '@intradocs/db/discovery';
import { retentionOverview } from '@intradocs/db/workflow';
import { readRetentionWindows } from '@intradocs/core/config';
import { PageHeading, Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { formatDate, formatNumber, formatRelative, hasCapability, initials } from '@intradocs/core';
import { aiStatus } from '@/lib/rag';
import { SortSelect } from '@/components/sort-select';

/**
 * Dashboard (mockup S10) on real numbers only: every figure is a count from the audit
 * trail or a table under this actor's RLS. Charts are CSS on those counts; nothing is
 * smoothed, projected or compared to a made-up target.
 */
async function currentTime() {
  return new Date();
}
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; unit?: string }>;
}) {
  const actor = await requireActor('analytics.view'),
    params = await searchParams,
    raw = params.days ?? '30',
    days = ['7', '30', '90'].includes(raw) ? Number(raw) : 30,
    unit =
      String(params.unit ?? '')
        .trim()
        .slice(0, 80) || null;
  const data = await dashboardData(actor.id, days, unit);
  // What the retention policy will do next, in this administrator's scope. Taxonomy
  // administrators (taxonomy.view) see it; the database limits it to their categories.
  const windows = readRetentionWindows(process.env);
  const retention = hasCapability(actor, 'taxonomy.view')
    ? await retentionOverview(actor.id, windows)
    : null;
  const RETENTION_STATE = {
    expired: { text: 'Kedaluwarsa', pill: 'p-red', verb: 'diarsipkan otomatis' },
    overdue: {
      text: 'Review terlewat',
      pill: 'p-red',
      verb: 'dieskalasi ke admin; terlewat sejak',
    },
    due: { text: 'Review jatuh tempo', pill: 'p-amber', verb: 'menunggu pemilik; jatuh tempo' },
    soon: { text: 'Review 14 hari', pill: 'p-blue', verb: 'pengingat terkirim; review' },
  } as const;
  // Server component: "today" is fixed once per request, like the data it frames.
  const now = await currentTime();
  const aiOn = aiStatus().retrieval !== 'off';
  const canUpload = hasCapability(actor, 'documents.upload');
  const aiAsked = data.ai.retrievals + data.ai.answers + data.ai.abstained;
  const reads = data.activity.reduce((n, r) => n + r.reads, 0);
  const href = (d: number, u: string | null) =>
    `/admin/dashboard?days=${d}${u ? `&unit=${encodeURIComponent(u)}` : ''}`;

  // Bars: the last 14 days of the period (or all of it when shorter) as a real timeline
  // -- quiet days are drawn as empty columns rather than skipped -- scaled to the busiest
  // day so the tallest bar always reaches the top of the chart.
  const byDay = new Map(data.activity.map((r) => [r.day, r]));
  const span = Math.min(14, days);
  const series = Array.from({ length: span }, (_, i) => {
    const d = new Date(now.getTime() - (span - 1 - i) * 86_400_000);
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(d);
    return byDay.get(day) ?? { day, reads: 0, asks: 0 };
  });
  const peak = Math.max(1, ...series.map((r) => Math.max(r.reads, r.asks)));
  const status = [
    { name: 'Published', value: data.summary.active, color: 'var(--green)' },
    { name: 'Menunggu approval', value: data.summary.reviewing, color: '#ea580c' },
    { name: 'Draft / revisi', value: data.summary.drafts, color: 'var(--blue-600)' },
    { name: 'Kedaluwarsa', value: data.summary.expired, color: 'var(--red)' },
  ];
  const statusTotal = status.reduce((n, s) => n + s.value, 0);
  let acc = 0;
  const donut = status
    .map((s) => {
      const from = acc;
      acc += statusTotal ? (s.value / statusTotal) * 100 : 0;
      return `${s.color} ${from}% ${acc}%`;
    })
    .join(', ');
  const popularPeak = Math.max(1, ...data.popular.map((p) => p.searches));

  return (
    <div className="pad">
      <PageHeading
        title="Dashboard Knowledge Base"
        subtitle={`${days} hari terakhir${unit ? ` · unit ${unit}` : ''}`}
        actions={
          <div className="row">
            <SortSelect
              value={String(days)}
              options={[7, 30, 90].map(
                (n) => [String(n), `${n} hari terakhir`, href(n, unit)] as const,
              )}
            />
            <SortSelect
              value={unit ?? ''}
              options={[
                ['', 'Semua unit terlihat', href(days, null)] as const,
                ...data.units.map((u) => [u, u, href(days, u)] as const),
              ]}
            />
            <a
              className="btn btn-sm"
              href={`/api/reports/dashboard?days=${days}${unit ? `&unit=${encodeURIComponent(unit)}` : ''}`}
              title="Unduh angka di halaman ini sebagai CSV"
            >
              <Icon name="download" size={14} />
              Ekspor CSV
            </a>
          </div>
        }
      />

      <div className="grid kpi-grid mb">
        {[
          {
            label: 'Dokumen aktif',
            value: formatNumber(data.summary.active),
            note: 'Terbit dan belum kedaluwarsa',
            icon: 'book',
          },
          {
            label: 'Pembacaan & pertanyaan AI',
            value: formatNumber(reads + (aiOn ? aiAsked : 0)),
            note: `${formatNumber(reads)} pembacaan · ${aiOn ? formatNumber(aiAsked) : 0} pertanyaan dalam ${days} hari`,
            icon: 'eye',
          },
          {
            label: 'Rata-rata waktu approval',
            value:
              data.approvalHours === null
                ? '—'
                : data.approvalHours < 1
                  ? `${Math.max(1, Math.round(data.approvalHours * 60))} menit`
                  : data.approvalHours < 48
                    ? `${Math.round(data.approvalHours * 10) / 10} jam`
                    : `${Math.round(data.approvalHours / 24)} hari`,
            note: 'Dari pengajuan sampai persetujuan final',
            icon: 'clock',
          },
          {
            label: 'Pencarian tanpa hasil',
            value: data.search.total
              ? `${Math.round((data.search.zero / data.search.total) * 100)}%`
              : '—',
            note: `${data.search.zero} dari ${data.search.total} pencarian · ${data.gaps.length} topik kosong`,
            icon: 'search',
          },
          {
            label: 'AI Assistant',
            value: aiOn ? formatNumber(aiAsked) : 'Mati',
            note: aiOn
              ? `${data.ai.abstained} tidak terjawab · ${data.ai.rejected} kutipan disaring` +
                (data.ai.helpful + data.ai.unhelpful > 0
                  ? ` · membantu ${data.ai.helpful}/${data.ai.helpful + data.ai.unhelpful}`
                  : '')
              : 'Retrieval belum diaktifkan operator',
            icon: 'spark',
          },
        ].map((m) => (
          <section className="card card-b kpi" key={m.label}>
            <div className="row metric-label">
              <Icon name={m.icon} />
              {m.label}
            </div>
            <div className="metric-value">{m.value}</div>
            <p className="metric-note">{m.note}</p>
          </section>
        ))}
      </div>

      <div className="dash-row-2 mb">
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Aktivitas knowledge base</h2>
            <div className="legend ml-auto">
              <span>
                <i style={{ background: 'var(--blue-600)' }} /> Pembacaan dokumen
              </span>
              <span>
                <i style={{ background: 'var(--ai)' }} /> Pertanyaan ke AI
              </span>
            </div>
          </div>
          <div className="card-b">
            {series.length ? (
              <>
                <div className="chart" role="img" aria-label="Pembacaan dan pertanyaan per hari">
                  {series.map((r) => (
                    <div
                      className="cb"
                      key={r.day}
                      title={`${r.day}: ${r.reads} baca, ${r.asks} tanya`}
                    >
                      <div className="cb-bars">
                        <div className="bb" style={{ height: `${(r.reads / peak) * 100}%` }} />
                        <div className="bb alt" style={{ height: `${(r.asks / peak) * 100}%` }} />
                      </div>
                      <div className="lb">{r.day.slice(8)}</div>
                    </div>
                  ))}
                </div>
                <table className="sr-only">
                  <caption>Aktivitas per hari</caption>
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Pembacaan</th>
                      <th>Pertanyaan AI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((r) => (
                      <tr key={r.day}>
                        <td>{r.day}</td>
                        <td>{r.reads}</td>
                        <td>{r.asks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="sub tiny">
                  {series.length} hari terakhir dengan aktivitas (WIB). Puncak {peak} event dalam
                  sehari.
                </p>
              </>
            ) : (
              <Empty title="Belum ada aktivitas">
                Belum ada pembacaan atau pertanyaan pada periode ini.
              </Empty>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Status dokumen</h2>
          </div>
          <div className="card-b donut-wrap">
            <div
              className="donut"
              role="img"
              aria-label={`${statusTotal} dokumen menurut status`}
              style={{
                background: statusTotal ? `conic-gradient(${donut})` : 'var(--line-2)',
              }}
            >
              <div className="donut-c">
                <strong>{formatNumber(statusTotal)}</strong>
                <span>dokumen</span>
              </div>
            </div>
            <ul className="status-legend">
              {status.map((s) => (
                <li key={s.name}>
                  <i style={{ background: s.color }} />
                  <span>{s.name}</span>
                  <strong>{formatNumber(s.value)}</strong>
                </li>
              ))}
            </ul>
            {data.summary.expired > 0 && (
              <p className="sub tiny">
                {data.summary.expired} dokumen lewat tanggal review dan dikeluarkan dari index AI.
              </p>
            )}
          </div>
        </section>
      </div>

      {retention && (
        <section className="card mb">
          <div className="card-h">
            <h2 className="h3">Retensi &amp; review berkala</h2>
            <span className={`pill ${retention.length ? 'p-amber' : 'p-grey'} ml-auto`}>
              {retention.length} dokumen
            </span>
          </div>
          <div className="card-b">
            <p className="sub tiny">
              Kebijakan berjalan sendiri tiap jam: dokumen kedaluwarsa yang tidak diperbarui dalam{' '}
              {windows.graceDays} hari diarsipkan; review yang terlewat lebih dari{' '}
              {windows.overdueDays} hari dieskalasi ke admin kategori. Pemilik dapat mengonfirmasi
              &ldquo;masih berlaku&rdquo; dari halaman dokumen.
            </p>
            {retention.length ? (
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabel retensi">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Dokumen</th>
                      <th>Pemilik</th>
                      <th>Kategori</th>
                      <th>Tindakan kebijakan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {retention.map((r) => {
                      const s = RETENTION_STATE[r.state];
                      return (
                        <tr key={r.documentId}>
                          <td>
                            <span className={`pill ${s.pill}`}>{s.text}</span>
                          </td>
                          <td>
                            <Link href={documentHref({ id: r.documentId, slug: r.slug })}>
                              {r.title}
                            </Link>
                          </td>
                          <td>{r.ownerLabel}</td>
                          <td>{r.categoryName}</td>
                          <td className="sub">
                            {s.verb}{' '}
                            <time dateTime={r.dueAt} title={formatDate(r.dueAt)}>
                              {formatRelative(r.dueAt)}
                            </time>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="sub">
                Tidak ada dokumen yang mendekati review, terlewat, atau kedaluwarsa dalam cakupan
                Anda.
              </p>
            )}
          </div>
        </section>
      )}
      <div className="dash-row-3 mb">
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Pencarian terpopuler</h2>
          </div>
          <div className="card-b">
            {data.popular.length ? (
              <ul className="pop-list">
                {data.popular.map((p) => (
                  <li key={p.term}>
                    <span className="pop-term">{p.term}</span>
                    <span className="bar">
                      <span style={{ width: `${(p.searches / popularPeak) * 100}%` }} />
                    </span>
                    <strong>{formatNumber(p.searches)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub">
                Belum ada istilah yang dicari oleh minimal tiga orang berbeda pada periode ini.
                Pencarian satu-dua orang tidak pernah ditampilkan.
              </p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Kesenjangan knowledge</h2>
            <span className={`pill ${data.gaps.length ? 'p-amber' : 'p-grey'} ml-auto`}>
              {data.gaps.length} topik
            </span>
          </div>
          <div className="card-b">
            <p className="sub tiny">
              Dicari atau ditanyakan oleh ≥3 orang tanpa hasil — usulan prioritas penulisan.
            </p>
            {data.gaps.length ? (
              <ul className="gap-list">
                {data.gaps.map((g) => (
                  <li key={g.term}>
                    <div>
                      <div className="gap-t">{g.term}</div>
                      <div className="sub tiny">
                        {formatNumber(g.searches)} pencarian · {formatNumber(g.people)} orang
                        {g.fromAssistant > 0 ? ` · ${g.fromAssistant} via asisten` : ''} ·{' '}
                        <time dateTime={g.lastSeen} title={formatDate(g.lastSeen)}>
                          {formatRelative(g.lastSeen)}
                        </time>
                      </div>
                    </div>
                    {/* The safe form of "FAQ": the answer becomes an IntraDocs document that
                        goes through review and can be cited -- not a WeKnora FAQ entry that
                        nothing can validate. */}
                    {canUpload && (
                      <Link
                        className="btn btn-sm"
                        href={`/unggah?topik=${encodeURIComponent(g.term)}`}
                      >
                        Jawab sebagai dokumen
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub">Belum ada istilah yang memenuhi ambang tiga orang.</p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Kontributor teratas</h2>
          </div>
          <div className="card-b">
            {data.contributors.length ? (
              <ol className="rank-list">
                {data.contributors.map((c, i) => (
                  <li key={c.name}>
                    <span className="rank">{i + 1}</span>
                    <span className="avatar avatar-xs">{initials(c.name)}</span>
                    <span className="rank-name">{c.name}</span>
                    <strong>{c.total}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="sub">Belum ada publikasi pada periode ini.</p>
            )}
            <p className="sub tiny">Dokumen yang disetujui dalam periode, menurut pemilik.</p>
          </div>
        </section>
      </div>

      <section className="card mb">
        <div className="card-h">
          <h2 className="h3">Publikasi terbaru</h2>
          <Link className="btn btn-sm ml-auto" href="/katalog">
            Buka katalog <Icon name="arrow-r" size={13} />
          </Link>
        </div>
        {data.latest.length ? (
          <ul className="personal-list">
            {data.latest.map((d) => (
              <li key={d.id}>
                <Link href={documentHref(d)}>{d.title}</Link>
                <span className="pill p-grey">{d.format}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Belum ada publikasi">
            Tidak ada publikasi terlihat pada periode/unit ini.
          </Empty>
        )}
      </section>
      <p className="sub tiny">
        Angka dihitung dari aktivitas dalam cakupan Anda; teks pertanyaan ke AI tidak disimpan di
        sini.
      </p>
    </div>
  );
}
