import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { taModel } from '@intradocs/db/ta';
import { listDocuments } from '@intradocs/db/queries';
import { parseCatalogQuery, parseUuid } from '@intradocs/core/validation';
import { formatDate } from '@intradocs/core';
import {
  TA_ENVIRONMENT_LABELS,
  TA_KIND_LABELS,
  TA_RELATIONS,
  TA_STATUS_LABELS,
  daysToEndOfSupport,
  dependenciesOf,
  impactOf,
} from '@intradocs/core/ta';
import { PageHeading, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { TaEosPill, TA_KIND_ICON } from '@/components/ta-shared';
export const dynamic = 'force-dynamic';

async function currentTime() {
  return new Date();
}

export default async function TaElementPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  let id: string;
  try {
    id = parseUuid((await params).id);
  } catch {
    notFound();
  }
  const { elements, relations } = await taModel(actor.id);
  const element = elements.find((e) => e.id === id);
  if (!element) notFound();
  const today = await currentTime();
  const byId = new Map(elements.map((e) => [e.id, e]));
  const outgoing = relations.filter((r) => r.sourceId === id);
  const incoming = relations.filter((r) => r.targetId === id);
  const impact = impactOf(id, relations);
  const needs = dependenciesOf(id, relations);
  // Runbooks and SOPs that mention this element by hostname or name, in the reader's scope.
  const term = element.hostname ?? element.name;
  const docs =
    term.length >= 3
      ? (await listDocuments(actor.id, parseCatalogQuery({ q: term }))).items.slice(0, 5)
      : [];
  const facts: Array<[string, React.ReactNode]> = [
    ['Jenis', TA_KIND_LABELS[element.kind]],
    ['Status', TA_STATUS_LABELS[element.status]],
    ['Hostname', element.hostname ? <code key="h">{element.hostname}</code> : null],
    ['Alamat IP', element.ipAddress ? <code key="ip">{element.ipAddress}</code> : null],
    ['Lingkungan', element.environment ? TA_ENVIRONMENT_LABELS[element.environment] : null],
    ['OS / platform', [element.os, element.osVersion].filter(Boolean).join(' ') || null],
    ['Lokasi', element.location],
    ['Pemilik', element.owner],
    [
      'End of support',
      element.endOfSupport ? (
        <span key="eos">
          {formatDate(element.endOfSupport)} <TaEosPill days={daysToEndOfSupport(element, today)} />
        </span>
      ) : null,
    ],
    ...Object.entries(element.attributes).map(([k, v]) => [k, v] as [string, React.ReactNode]),
  ];
  const link = (eid: string) => {
    const e = byId.get(eid);
    return e ? (
      <Link href={`/arsitektur/${e.id}`} className="ta-name">
        <Icon name={TA_KIND_ICON[e.kind]} size={14} />
        {e.name}
      </Link>
    ) : null;
  };
  return (
    <div className="pad">
      <p className="sub tiny">
        <Link href="/arsitektur">← Technology Architecture</Link>
      </p>
      <PageHeading
        title={element.name}
        subtitle={`${TA_KIND_LABELS[element.kind]}${element.externalId ? ' · GUID Sparx ' + element.externalId : ''}`}
      />
      <div className="ta-detail">
        <section className="card card-b">
          <h2 className="h3">Atribut</h2>
          <dl className="ta-facts">
            {facts
              .filter(([, v]) => v !== null && v !== '')
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {element.description && <p className="ta-desc">{element.description}</p>}
        </section>
        <section className="card card-b">
          <h2 className="h3">Relasi</h2>
          {outgoing.length + incoming.length === 0 ? (
            <p className="sub">Tidak ada relasi tercatat.</p>
          ) : (
            <ul className="ta-rel">
              {outgoing.map((r) => (
                <li key={r.id}>
                  <span className="sub">{TA_RELATIONS[r.kind].label}</span> {link(r.targetId)}
                </li>
              ))}
              {incoming.map((r) => (
                <li key={r.id}>
                  <span className="sub">{TA_RELATIONS[r.kind].inverse}</span> {link(r.sourceId)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card card-b">
          <h2 className="h3">
            <Icon name="alert" size={15} /> Dampak jika tidak tersedia
          </h2>
          <p className="sub tiny">
            Elemen yang bergantung pada {element.name}, langsung maupun berantai.
          </p>
          {impact.length ? (
            <ul className="ta-rel">
              {impact.map((i) => (
                <li key={i.id}>
                  <span className={`pill ${i.depth === 1 ? 'p-red' : 'p-amber'}`}>
                    {i.depth === 1 ? 'langsung' : `tingkat ${i.depth}`}
                  </span>{' '}
                  {link(i.id)}
                  {i.depth > 1 && <span className="sub tiny"> lewat {byId.get(i.via)?.name}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">Tidak ada elemen yang tercatat bergantung padanya.</p>
          )}
        </section>
        <section className="card card-b">
          <h2 className="h3">
            <Icon name="flow" size={15} /> Bergantung pada
          </h2>
          {needs.length ? (
            <ul className="ta-rel">
              {needs.map((i) => (
                <li key={i.id}>
                  <span className="pill p-grey">
                    {i.depth === 1 ? 'langsung' : `tingkat ${i.depth}`}
                  </span>{' '}
                  {link(i.id)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">Tidak bergantung pada elemen lain yang tercatat.</p>
          )}
        </section>
        <section className="card card-b">
          <h2 className="h3">
            <Icon name="book" size={15} /> Dokumen terkait
          </h2>
          {docs.length ? (
            <ul className="ta-rel">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link href={documentHref(d)}>{d.title}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">Belum ada dokumen yang menyebut {term}.</p>
          )}
        </section>
      </div>
    </div>
  );
}
