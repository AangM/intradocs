import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { taModel } from '@intradocs/db/ta';
import { hasCapability, formatDate, formatNumber } from '@intradocs/core';
import {
  TA_ENVIRONMENT_LABELS,
  TA_ENVIRONMENTS,
  TA_KIND_LABELS,
  TA_KINDS,
  TA_STATUS_LABELS,
  daysToEndOfSupport,
  type TaKind,
} from '@intradocs/core/ta';
import { PageHeading, Empty } from '@/components/shared';
import { Icon } from '@/components/icon';
import { TaAsk } from '@/components/ta-ask';
import { TaEosPill, TA_KIND_ICON } from '@/components/ta-shared';
export const dynamic = 'force-dynamic';

/** Request clock, read once outside render. */
async function currentTime() {
  return new Date();
}

export default async function TechnologyArchitecture({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  const pick = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '');
  const { elements, relations } = await taModel(actor.id);
  const today = await currentTime();
  const q = pick('q').trim().toLowerCase().slice(0, 100);
  const kind = (TA_KINDS as readonly string[]).includes(pick('kind'))
    ? (pick('kind') as TaKind)
    : null;
  const env = (TA_ENVIRONMENTS as readonly string[]).includes(pick('env')) ? pick('env') : null;
  const eosOnly = pick('eos') === '1';
  const live = elements.filter((e) => e.status !== 'retired');
  const eosSoon = live.filter((e) => {
    const d = daysToEndOfSupport(e, today);
    return d !== null && d <= 180;
  });
  const shown = elements.filter(
    (e) =>
      (!kind || e.kind === kind) &&
      (!env || e.environment === env) &&
      (!eosOnly || eosSoon.includes(e)) &&
      (!q ||
        [e.name, e.hostname, e.ipAddress, e.os, e.location, e.owner]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q))),
  );
  const counts = TA_KINDS.map((k) => ({ k, n: live.filter((e) => e.kind === k).length })).filter(
    (c) => c.n > 0,
  );
  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = {
      q: pick('q'),
      kind: kind ?? '',
      env: env ?? '',
      eos: eosOnly ? '1' : '',
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return `/arsitektur${s ? '?' + s : ''}`;
  };
  const canImport = hasCapability(actor, 'taxonomy.view');
  return (
    <div className="pad">
      <PageHeading
        title="Technology Architecture"
        subtitle={`Layer teknologi EA: ${formatNumber(live.length)} elemen aktif, ${formatNumber(relations.length)} relasi · sumber model Sparx EA`}
        actions={
          canImport ? (
            <Link className="btn" href="/arsitektur/impor">
              <Icon name="upload" size={14} />
              Impor dari Sparx
            </Link>
          ) : undefined
        }
      />
      {elements.length === 0 ? (
        <Empty title="Belum ada model arsitektur di cakupan Anda">
          {canImport
            ? 'Impor ekspor XMI dari Sparx EA atau template CSV untuk mulai.'
            : 'Model Technology Architecture dikelola admin kategori; elemen muncul di sini setelah diimpor ke kategori yang boleh Anda baca.'}
        </Empty>
      ) : (
        <>
          <TaAsk />
          <div className="ta-kpis">
            {counts.map((c) => (
              <Link
                key={c.k}
                href={href({ kind: kind === c.k ? null : c.k })}
                className={`card ta-kpi${kind === c.k ? ' is-on' : ''}`}
              >
                <span className="ta-kpi-ic">
                  <Icon name={TA_KIND_ICON[c.k]} size={16} />
                </span>
                <strong>{c.n}</strong>
                <span>{TA_KIND_LABELS[c.k]}</span>
              </Link>
            ))}
            <Link
              href={href({ eos: eosOnly ? null : '1' })}
              className={`card ta-kpi warn${eosOnly ? ' is-on' : ''}`}
            >
              <span className="ta-kpi-ic">
                <Icon name="alert" size={16} />
              </span>
              <strong>{eosSoon.length}</strong>
              <span>End of support ≤ 180 hari / lewat</span>
            </Link>
          </div>
          <form className="card card-b ta-filter" method="get" action="/arsitektur">
            <label className="ta-search">
              <Icon name="search" size={15} />
              <input
                className="inp"
                name="q"
                defaultValue={pick('q')}
                placeholder="Cari nama, hostname, IP, OS, lokasi…"
                aria-label="Cari elemen"
              />
            </label>
            <select className="inp" name="kind" defaultValue={kind ?? ''} aria-label="Jenis elemen">
              <option value="">Semua jenis</option>
              {TA_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TA_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <select className="inp" name="env" defaultValue={env ?? ''} aria-label="Lingkungan">
              <option value="">Semua lingkungan</option>
              {TA_ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {TA_ENVIRONMENT_LABELS[e]}
                </option>
              ))}
            </select>
            {eosOnly && <input type="hidden" name="eos" value="1" />}
            <button className="btn btn-p" type="submit">
              Terapkan
            </button>
          </form>
          <div className="card">
            {shown.length ? (
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Tabel elemen arsitektur"
              >
                <table className="tbl ta-table">
                  <thead>
                    <tr>
                      <th scope="col">Elemen</th>
                      <th scope="col">Jenis</th>
                      <th scope="col">Hostname / IP</th>
                      <th scope="col">OS / platform</th>
                      <th scope="col">Lingkungan</th>
                      <th scope="col">Lokasi</th>
                      <th scope="col">End of support</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Link href={`/arsitektur/${e.id}`} className="ta-name">
                            <Icon name={TA_KIND_ICON[e.kind]} size={14} />
                            {e.name}
                          </Link>
                          {e.status !== 'active' && (
                            <span className="pill p-grey ta-status">
                              {TA_STATUS_LABELS[e.status]}
                            </span>
                          )}
                        </td>
                        <td className="sub">{TA_KIND_LABELS[e.kind]}</td>
                        <td>
                          {e.hostname && <code>{e.hostname}</code>}
                          {e.ipAddress && <div className="sub tiny">{e.ipAddress}</div>}
                        </td>
                        <td className="sub">
                          {[e.os, e.osVersion].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="sub">
                          {e.environment ? TA_ENVIRONMENT_LABELS[e.environment] : '—'}
                        </td>
                        <td className="sub">{e.location ?? '—'}</td>
                        <td>
                          {e.endOfSupport ? (
                            <>
                              <span className="sub">{formatDate(e.endOfSupport)}</span>{' '}
                              <TaEosPill days={daysToEndOfSupport(e, today)} />
                            </>
                          ) : (
                            <span className="sub">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Tidak ada elemen untuk filter ini">
                <Link href="/arsitektur">Hapus filter</Link>
              </Empty>
            )}
          </div>
        </>
      )}
    </div>
  );
}
