import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TaParseError,
  answerTaQuestion,
  dependenciesOf,
  elementCard,
  impactOf,
  kindFromSparx,
  parseSparxXmi,
  parseTaCsv,
  parseTaImport,
  relationFromSparx,
  type TaElement,
  type TaRelation,
} from '../../packages/core/src/ta.ts';

const xmi = readFileSync('fixtures/ta/sparx-technology-demo.xmi', 'utf8');
const csv = readFileSync('fixtures/ta/technology-template.csv', 'utf8');

/** The fixture as the database would hold it: ids = GUIDs, relations resolved. */
function model() {
  const parsed = parseSparxXmi(xmi);
  const elements: TaElement[] = parsed.elements.map((e) => ({ ...e, id: e.externalId }));
  const relations: TaRelation[] = parsed.relations.map((r, i) => ({
    id: String(i),
    sourceId: r.sourceExternalId,
    targetId: r.targetExternalId,
    kind: r.kind,
  }));
  const byName = (n: string) => elements.find((e) => e.name === n)!;
  return { elements, relations, byName };
}

test('the Sparx XMI export becomes typed elements and relations; business elements are skipped and said so', () => {
  const r = parseSparxXmi(xmi);
  assert.equal(r.elements.length, 31);
  assert.equal(r.relations.length, 51);
  assert.deepEqual(r.skipped, [
    'Divisi Keuangan (uml:Actor «ArchiMate_BusinessActor»): bukan elemen Technology Architecture, dilewati.',
  ]);
  const vm = r.elements.find((e) => e.name === 'srv-app-01')!;
  assert.deepEqual(
    [
      vm.kind,
      vm.hostname,
      vm.ipAddress,
      vm.environment,
      vm.os,
      vm.osVersion,
      vm.endOfSupport,
      vm.owner,
      vm.status,
    ],
    [
      'virtual_machine',
      'srv-app-01',
      '10.10.20.31',
      'production',
      'Windows Server',
      '2016',
      '2027-01-12',
      'Tim Aplikasi',
      'active',
    ],
  );
  assert.equal(r.elements.find((e) => e.name === 'srv-legacy-01')!.status, 'retiring');
  assert.equal(
    r.elements.find((e) => e.name === 'esx-jkt-01')!.attributes.ram,
    '512 GB',
    'other tags kept as attributes',
  );
  assert.equal(r.elements.find((e) => e.name === 'Segmen DMZ')!.kind, 'network_segment');
});

test('the CSV template reads to the same model as the XMI', () => {
  const a = parseSparxXmi(xmi);
  const b = parseTaCsv(csv);
  const key = (x: typeof a) => ({
    elements: x.elements
      .map((e) => [e.externalId, e.kind, e.name, e.hostname, e.endOfSupport])
      .sort(),
    relations: x.relations
      .map((r) => [r.sourceExternalId, r.kind, r.targetExternalId].join('|'))
      .sort(),
  });
  assert.deepEqual(key(b), key(a));
  assert.equal(parseTaImport('model.xmi', xmi).format, 'xmi');
  assert.equal(parseTaImport('model.csv', csv).format, 'csv');
  assert.throws(() => parseTaImport('model.docx', 'x'), TaParseError);
});

test('hostile or broken XML is refused before anything is read', () => {
  assert.throws(
    () => parseSparxXmi('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>'),
    /DOCTYPE/,
  );
  assert.throws(() => parseSparxXmi('<xmi:XMI><a></b></xmi:XMI>'), /well-formed/);
  assert.throws(() => parseSparxXmi('<xmi:XMI></xmi:XMI>'), /Bukan ekspor XMI Sparx/);
  assert.throws(() => parseTaCsv('Name,Type\nx,Node'), /guid/i);
  assert.throws(() => parseTaCsv('GUID,Type,Name\n"a,Node,x'), /kutip/);
});

test('duplicate GUIDs, self-loops, dangling relations and bad values are caught', () => {
  const header = 'GUID,Type,Stereotype,Name,ip_address,end_of_support';
  assert.throws(
    () => parseTaCsv(`${header}\n{A},Node,server,a,,\n{A},Node,server,b,,`),
    /GUID ganda/,
  );
  const r = parseTaCsv(
    `${header}\n{A},Node,server,a,999.1.1.1,31/13/2026\n{B},Node,server,b,10.0.0.1,01/02/2027\n#relations\nGUID,SourceGUID,TargetGUID,Type,Stereotype\n,{A},{A},Dependency,\n,{A},{Z},Dependency,\n,{A},{B},Dependency,`,
  );
  assert.equal(r.elements[0]!.ipAddress, null);
  assert.equal(r.elements[0]!.endOfSupport, null);
  assert.equal(
    r.elements[1]!.endOfSupport,
    '2027-02-01',
    'day/month/year as Indonesian sheets write it',
  );
  assert.equal(r.relations.length, 1);
  assert(r.skipped.some((s) => /IP/.test(s)) && r.skipped.some((s) => /tanggal/.test(s)));
});

test('Sparx types and stereotypes map to kinds; connectors orient the way dependencies run', () => {
  assert.equal(kindFromSparx('uml:Device', 'firewall'), 'network_device');
  assert.equal(kindFromSparx('uml:Node', ''), 'server');
  assert.equal(kindFromSparx('uml:ExecutionEnvironment', ''), 'platform');
  assert.equal(kindFromSparx('uml:Node', 'x', 'storage'), 'storage', 'a kind tag wins');
  assert.equal(kindFromSparx('uml:Actor', 'ArchiMate_BusinessActor'), null);
  assert.deepEqual(relationFromSparx('Association', 'ArchiMate_Serving'), {
    kind: 'depends_on',
    swap: true,
  });
  assert.deepEqual(relationFromSparx('Deployment', ''), { kind: 'runs_on', swap: false });
  assert.equal(relationFromSparx('NoteLink', ''), null);
});

test('impact: a hypervisor failing takes its VMs, what runs on them and what uses that', () => {
  const { relations, byName } = model();
  const names = (ids: { id: string }[]) =>
    ids.map((r) => model().elements.find((e) => e.id === r.id)!.name).sort();
  const impact = impactOf(byName('esx-jkt-02').id, relations);
  const hit = names(impact);
  for (const n of [
    'srv-db-01',
    'srv-app-02',
    'PostgreSQL 16',
    'Portal Tiket',
    'IntraDocs',
    'Aplikasi Absensi',
  ])
    assert(hit.includes(n), `${n} should be impacted`);
  assert(!hit.includes('srv-db-dr-01'), 'the DR copy is on another host');
  assert.equal(impact.find((i) => i.id === byName('srv-db-01').id)!.depth, 1);
  // Aplikasi Absensi runs on esx-jkt-01, but needs PostgreSQL 16 on esx-jkt-02: depth > 1.
  assert(impact.find((i) => i.id === byName('Aplikasi Absensi').id)!.depth > 1);
  // The core switch is under everything on the network.
  assert(names(impactOf(byName('core-sw-jkt-01').id, relations)).includes('Portal Tiket'));
  // ArchiMate serving: the load balancer serves Portal Tiket, so the portal depends on it.
  assert(names(impactOf(byName('lb-jkt-01').id, relations)).includes('Portal Tiket'));
});

test('dependencies: what an application needs, down to the building', () => {
  const { relations, byName, elements } = model();
  const deps = dependenciesOf(byName('Portal Tiket').id, relations).map(
    (d) => elements.find((e) => e.id === d.id)!.name,
  );
  for (const n of [
    'srv-app-02',
    'esx-jkt-02',
    'san-jkt-01',
    'PostgreSQL 16',
    'Active Directory',
    'lb-jkt-01',
    'DC Jakarta (Cibitung)',
  ])
    assert(deps.includes(n), `${n} missing`);
  assert(!deps.includes('Portal Tiket'));
});

test('questions: impact, dependencies, end of support, inventory, a single element, and "I do not know"', () => {
  const { elements, relations } = model();
  const today = new Date('2026-09-24T00:00:00Z');
  const ask = (q: string) => answerTaQuestion(q, elements, relations, today);

  const impact = ask('Apa dampaknya jika srv-db-01 mati?');
  assert.equal(impact.type, 'impact');
  if (impact.type === 'impact') {
    assert.equal(impact.subject.name, 'srv-db-01');
    assert(impact.items.some((i) => i.element.name === 'Portal Tiket'));
  }
  const deps = ask('Portal Tiket bergantung pada apa saja?');
  assert.equal(deps.type, 'dependencies');

  const eos = ask('Server mana saja yang sudah end of support?');
  assert.equal(eos.type, 'list');
  if (eos.type === 'list') {
    const n = eos.items.map((e) => e.name);
    assert(n.includes('srv-mon-01') && n.includes('esx-jkt-01') && n.includes('PostgreSQL 13'));
    assert(!n.includes('srv-app-01'), 'Windows 2016 ends in January: not yet past');
  }
  const soon = ask('Apa saja yang mendekati end of support?');
  if (soon.type === 'list') assert(soon.items.some((e) => e.name === 'srv-app-01'));

  const inv = ask('Berapa VM di lingkungan production?');
  assert.equal(inv.type, 'list');
  if (inv.type === 'list') {
    assert(inv.items.every((e) => e.kind === 'virtual_machine' && e.environment === 'production'));
    assert.equal(inv.items.length, 8);
  }
  const byOs = ask('Daftar server dengan Windows Server');
  if (byOs.type === 'list') assert(byOs.items.every((e) => (e.os ?? '').includes('Windows')));
  const dr = ask('elemen apa saja di DRC Surabaya?');
  assert.equal(dr.type, 'list');
  if (dr.type === 'list')
    assert.deepEqual(dr.items.map((e) => e.name).sort(), ['esx-sby-01', 'srv-db-dr-01']);

  const one = ask('10.10.30.41');
  assert.equal(one.type, 'element');
  if (one.type === 'element') assert.equal(one.subject.name, 'srv-db-01');

  assert.equal(ask('Bagaimana cara mengajukan cuti?').type, 'none');
  // A description is not an inventory: this one is for semantic search to place.
  assert.equal(ask('server untuk monitoring').type, 'none');
  const ubuntu = ask('berapa server ubuntu?');
  assert.equal(ubuntu.type, 'list');
  if (ubuntu.type === 'list') assert(ubuntu.items.every((e) => (e.os ?? '').startsWith('Ubuntu')));
});

test('an element card states the facts and the neighbours in words, for the search index', () => {
  const { elements, relations, byName } = model();
  const card = elementCard(byName('srv-db-01'), relations, new Map(elements.map((e) => [e.id, e])));
  assert.match(card, /^# srv-db-01\n/);
  assert.match(card, /Alamat IP: 10\.10\.30\.41/);
  assert.match(card, /srv-db-01 di-host oleh esx-jkt-02/);
  assert.match(card, /srv-db-01 menjalankan PostgreSQL 16/);
});
