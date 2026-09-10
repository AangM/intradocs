import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { dashboardData } from '@intradocs/db/discovery';
import { PageHeading, Notice, Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
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
  const reads = data.activity.reduce((n, r) => n + r.reads, 0);
  return (
    <div className="pad">
      <PageHeading
        title="Dashboard Knowledge Base"
        subtitle="Data aktual pada corpus sintetis, dibatasi scope akses Anda."
        actions={
          <form className="row wrap">
            <label>
              Periode
              <select className="inp" name="days" defaultValue={days}>
                {[7, 30, 90].map((n) => (
                  <option key={n} value={n}>
                    {n} hari
                  </option>
                ))}
              </select>
            </label>
            <label>
              Unit
              <select className="inp" name="unit" defaultValue={unit ?? ''}>
                <option value="">Semua unit terlihat</option>
                {data.units.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <button className="btn">Terapkan</button>
          </form>
        }
      />
      <div className="grid g4 mb">
        {[
          {
            label: 'Dokumen aktif',
            value: data.summary.active,
            note: 'Snapshot kini: approved, ready, belum expired',
            icon: 'book',
          },
          {
            label: 'Aktivitas baca',
            value: reads,
            note: `Event baca dalam ${days} hari`,
            icon: 'eye',
          },
          {
            label: 'Approval rata-rata',
            value: data.approvalHours === null ? '—' : `${data.approvalHours} jam`,
            note: 'Submit sampai persetujuan final',
            icon: 'clock',
          },
          {
            label: 'Pencarian tanpa hasil',
            value: data.search.total
              ? `${Math.round((data.search.zero / data.search.total) * 100)}%`
              : '—',
            note: `${data.search.zero} dari ${data.search.total} pencarian`,
            icon: 'search',
          },
        ].map((m) => (
          <section className="card card-b" key={m.label}>
            <div className="row metric-label">
              <Icon name={m.icon} />
              {m.label}
            </div>
            <div className="metric-value">{m.value}</div>
            <p className="metric-note">{m.note}</p>
          </section>
        ))}
      </div>
      <div className="grid g2 mb">
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Status versi terbaru</h2>
          </div>
          <div className="card-b status-breakdown">
            {[
              { name: 'Draft / revisi', value: data.summary.drafts },
              { name: 'Dalam review', value: data.summary.reviewing },
              { name: 'Kedaluwarsa', value: data.summary.expired },
            ].map((s) => (
              <p key={s.name}>
                <span>{s.name}</span>
                <strong>{s.value}</strong>
              </p>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Kontributor publikasi</h2>
          </div>
          <div className="card-b">
            {data.contributors.length ? (
              data.contributors.map((c) => (
                <p className="rank-row" key={c.name}>
                  <span>{c.name}</span>
                  <strong>{c.total} dokumen</strong>
                </p>
              ))
            ) : (
              <p className="sub">Belum ada publikasi pada periode ini.</p>
            )}
          </div>
        </section>
      </div>
      <section className="card mb">
        <div className="card-h">
          <h2 className="h3">Aktivitas baca harian</h2>
        </div>
        {data.activity.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Tabel aktivitas baca"
          >
            <table>
              <thead>
                <tr>
                  <th>Tanggal (WIB)</th>
                  <th>Event baca</th>
                </tr>
              </thead>
              <tbody>
                {data.activity.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td>{r.reads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Belum ada aktivitas">
            Belum ada event baca yang dapat ditampilkan pada periode ini.
          </Empty>
        )}
      </section>
      <Notice>
        Unit berdasarkan pemilik dokumen; metrik pencarian berdasarkan unit pencari. Status adalah
        snapshot kini, aktivitas mengikuti periode. AI/chat dan knowledge-gap semantik belum aktif;
        tidak ada metrik buatan atau pertanyaan mentah pada dashboard.
      </Notice>
      <section className="card">
        <div className="card-h">
          <h2 className="h3">Publikasi terbaru</h2>
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
    </div>
  );
}
