/**
 * Technology Architecture (TOGAF layer "Technology", ArchiMate technology layer): the
 * servers, devices, networks, platforms and software an IT unit runs, and how they
 * depend on each other. The modelling happens in Sparx Enterprise Architect; this module
 * reads what Sparx exports (XMI, or the CSV template) into typed elements and relations,
 * answers the questions people ask of such a model, and does so deterministically from
 * the data -- every answer names the elements it came from.
 *
 * Pure functions only: no database, no network. The database layer stores and scopes;
 * this module parses, validates and reasons.
 */

// --- vocabulary -------------------------------------------------------------------------

export const TA_KINDS = [
  'location',
  'network_segment',
  'network_device',
  'server',
  'storage',
  'virtual_machine',
  'platform',
  'software',
] as const;
export type TaKind = (typeof TA_KINDS)[number];
export const TA_KIND_LABELS: Record<TaKind, string> = {
  location: 'Lokasi',
  network_segment: 'Segmen jaringan',
  network_device: 'Perangkat jaringan',
  server: 'Server fisik',
  storage: 'Storage',
  virtual_machine: 'Virtual machine',
  platform: 'Platform / system software',
  software: 'Aplikasi / software',
};
export const TA_STATUSES = ['planned', 'active', 'retiring', 'retired'] as const;
export type TaStatus = (typeof TA_STATUSES)[number];
export const TA_STATUS_LABELS: Record<TaStatus, string> = {
  planned: 'Direncanakan',
  active: 'Aktif',
  retiring: 'Akan dipensiunkan',
  retired: 'Pensiun',
};
export const TA_ENVIRONMENTS = ['production', 'staging', 'development', 'dr'] as const;
export type TaEnvironment = (typeof TA_ENVIRONMENTS)[number];
export const TA_ENVIRONMENT_LABELS: Record<TaEnvironment, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  dr: 'Disaster recovery',
};
/**
 * Relation kinds, each read "source <kind> target". `dependsOn` says which end fails
 * when the other does: for hosts(A,B) the hosted B depends on A; for the rest the
 * source depends on the target.
 */
export const TA_RELATIONS = {
  hosts: { label: 'meng-host', inverse: 'di-host oleh', dependent: 'target' },
  runs_on: { label: 'berjalan di', inverse: 'menjalankan', dependent: 'source' },
  depends_on: { label: 'bergantung pada', inverse: 'dibutuhkan oleh', dependent: 'source' },
  connects_to: { label: 'terhubung ke', inverse: 'menghubungkan', dependent: 'source' },
  located_in: { label: 'berada di', inverse: 'menampung', dependent: 'source' },
  stores_on: { label: 'menyimpan data di', inverse: 'menyimpan data untuk', dependent: 'source' },
} as const;
export type TaRelationKind = keyof typeof TA_RELATIONS;
export const TA_RELATION_KINDS = Object.keys(TA_RELATIONS) as TaRelationKind[];

export interface TaElementInput {
  /** Stable id from the source model (Sparx GUID); the upsert key. */
  externalId: string;
  kind: TaKind;
  name: string;
  hostname: string | null;
  ipAddress: string | null;
  environment: TaEnvironment | null;
  location: string | null;
  os: string | null;
  osVersion: string | null;
  status: TaStatus;
  owner: string | null;
  endOfSupport: string | null; // YYYY-MM-DD
  description: string;
  /** Any other tagged value, kept as written. */
  attributes: Record<string, string>;
}
export interface TaRelationInput {
  externalId: string | null;
  sourceExternalId: string;
  targetExternalId: string;
  kind: TaRelationKind;
}
export interface TaParseResult {
  elements: TaElementInput[];
  relations: TaRelationInput[];
  /** What was read but not taken, in words a modeller can act on. */
  skipped: string[];
}
export class TaParseError extends Error {}

// --- shared normalisation -------------------------------------------------------------------

const LIMITS = { elements: 5000, relations: 20000, bytes: 5 * 1024 * 1024 };
const clean = (v: unknown, max = 300) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const orNull = (v: string) => (v ? v : null);

function normaliseStatus(raw: string): TaStatus {
  const s = raw.toLowerCase();
  if (/retir|pensiun|decom/.test(s) && !/retiring|akan/.test(s)) return 'retired';
  if (/retiring|phase.?out|akan|deprecat/.test(s)) return 'retiring';
  if (/plan|propos|rencana/.test(s)) return 'planned';
  return 'active';
}
function normaliseEnvironment(raw: string): TaEnvironment | null {
  const s = raw.toLowerCase();
  if (!s) return null;
  if (/^(prod|production|prd)/.test(s)) return 'production';
  if (/^(stag|stg|uat|pre)/.test(s)) return 'staging';
  if (/^(dev|test|sit|lab)/.test(s)) return 'development';
  if (/^(dr|drc|disaster)/.test(s)) return 'dr';
  return null;
}
function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!y) return null;
  const date = new Date(`${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/\d{1,2})?$/;

/**
 * Sparx type + stereotype -> kind. ArchiMate stereotypes first (they are the most
 * specific), then UML metaclasses, then words in the stereotype. A `kind` tag wins.
 */
export function kindFromSparx(type: string, stereotype: string, kindTag = ''): TaKind | null {
  const tag = kindTag.toLowerCase().replace(/[\s-]+/g, '_');
  if ((TA_KINDS as readonly string[]).includes(tag)) return tag as TaKind;
  const st = stereotype.toLowerCase();
  const t = type.toLowerCase().replace(/^uml:/, '');
  if (/location|lokasi|site|datacenter|data.?center/.test(st)) return 'location';
  if (/communicationnetwork|network|segment|vlan|subnet/.test(st)) return 'network_segment';
  if (/storage|san|nas/.test(st)) return 'storage';
  if (/virtual|vm\b|guest/.test(st)) return 'virtual_machine';
  if (/firewall|switch|router|loadbalancer|load.?balancer|device/.test(st)) return 'network_device';
  if (/systemsoftware|database|dbms|os\b|operating|runtime|middleware|platform/.test(st))
    return 'platform';
  if (/applicationcomponent|artifact|application|software|component/.test(st)) return 'software';
  if (/server|node|host/.test(st)) return 'server';
  if (t === 'device') return 'network_device';
  if (t === 'node') return 'server';
  if (t === 'executionenvironment') return 'platform';
  if (t === 'artifact' || t === 'component') return 'software';
  return null;
}
/** Sparx connector type + stereotype -> relation kind, oriented as TA_RELATIONS reads. */
export function relationFromSparx(
  type: string,
  stereotype: string,
): { kind: TaRelationKind; swap: boolean } | null {
  const st = stereotype.toLowerCase();
  const t = type.toLowerCase().replace(/^uml:/, '');
  if (/assignment|hosts?/.test(st)) return { kind: 'hosts', swap: false };
  if (/serving|serves/.test(st)) return { kind: 'depends_on', swap: true };
  if (/located|lokasi/.test(st)) return { kind: 'located_in', swap: false };
  if (/stores?|storage/.test(st)) return { kind: 'stores_on', swap: false };
  if (/connect|communication|flow|link/.test(st)) return { kind: 'connects_to', swap: false };
  if (/deploy|runs?.?on/.test(st) || t === 'deployment') return { kind: 'runs_on', swap: false };
  if (t === 'dependency' || /depend|uses?/.test(st)) return { kind: 'depends_on', swap: false };
  if (t === 'composition' || t === 'aggregation' || t === 'nesting')
    return { kind: 'hosts', swap: false };
  if (t === 'communicationpath' || t === 'association') return { kind: 'connects_to', swap: false };
  return null;
}

/** Tag names Sparx modellers use for the fields this module types; everything else is kept as an attribute. */
const FIELD_TAGS: Record<string, keyof TaElementInput> = {
  hostname: 'hostname',
  host: 'hostname',
  fqdn: 'hostname',
  ip: 'ipAddress',
  ip_address: 'ipAddress',
  ipaddress: 'ipAddress',
  environment: 'environment',
  env: 'environment',
  lingkungan: 'environment',
  location: 'location',
  lokasi: 'location',
  site: 'location',
  os: 'os',
  operating_system: 'os',
  os_version: 'osVersion',
  version: 'osVersion',
  versi: 'osVersion',
  owner: 'owner',
  pemilik: 'owner',
  end_of_support: 'endOfSupport',
  eos: 'endOfSupport',
  end_of_life: 'endOfSupport',
  eol: 'endOfSupport',
  status: 'status',
};
function elementFrom(
  externalId: string,
  kind: TaKind,
  name: string,
  status: string,
  notes: string,
  tags: Record<string, string>,
  skipped: string[],
): TaElementInput {
  const out: TaElementInput = {
    externalId,
    kind,
    name,
    hostname: null,
    ipAddress: null,
    environment: null,
    location: null,
    os: null,
    osVersion: null,
    status: normaliseStatus(status),
    owner: null,
    endOfSupport: null,
    description: clean(notes.replace(/<[^>]+>/g, ' '), 2000),
    attributes: {},
  };
  for (const [rawKey, rawValue] of Object.entries(tags)) {
    const key = rawKey.toLowerCase().replace(/[\s-]+/g, '_');
    const value = clean(rawValue);
    if (!value || key === 'kind') continue;
    const field = FIELD_TAGS[key];
    if (!field) {
      if (Object.keys(out.attributes).length < 40) out.attributes[clean(rawKey, 60)] = value;
      continue;
    }
    if (field === 'environment') out.environment = normaliseEnvironment(value);
    else if (field === 'status') out.status = normaliseStatus(value);
    else if (field === 'endOfSupport') {
      out.endOfSupport = normaliseDate(value);
      if (!out.endOfSupport)
        skipped.push(`${name}: tanggal end-of-support "${value}" tidak dikenali.`);
    } else if (field === 'ipAddress') {
      if (ipv4.test(value) || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(value)) out.ipAddress = value;
      else skipped.push(`${name}: alamat IP "${value}" tidak valid, diabaikan.`);
    } else if (field === 'hostname') out.hostname = value.toLowerCase();
    else (out as unknown as Record<string, string | null>)[field] = orNull(value);
  }
  return out;
}
function finish(result: TaParseResult): TaParseResult {
  if (result.elements.length > LIMITS.elements)
    throw new TaParseError(`Lebih dari ${LIMITS.elements} elemen; pecah impor per paket.`);
  if (result.relations.length > LIMITS.relations)
    throw new TaParseError(`Lebih dari ${LIMITS.relations} relasi.`);
  const seen = new Set<string>();
  for (const e of result.elements) {
    if (seen.has(e.externalId)) throw new TaParseError(`GUID ganda: ${e.externalId}.`);
    seen.add(e.externalId);
  }
  const relationKeys = new Set<string>();
  result.relations = result.relations.filter((r) => {
    if (!seen.has(r.sourceExternalId) || !seen.has(r.targetExternalId)) {
      result.skipped.push(`Relasi ${r.kind} menunjuk elemen di luar impor ini; diabaikan.`);
      return false;
    }
    if (r.sourceExternalId === r.targetExternalId) {
      result.skipped.push('Relasi ke dirinya sendiri diabaikan.');
      return false;
    }
    const key = `${r.sourceExternalId}|${r.kind}|${r.targetExternalId}`;
    if (relationKeys.has(key)) return false;
    relationKeys.add(key);
    return true;
  });
  return result;
}

// --- Sparx XMI ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)),
    )
    .replace(/&amp;/g, '&');
/**
 * A deliberately small XML reader for the shape Sparx writes. No DTD, no entities beyond
 * the five predefined ones and character references, no external anything -- a file
 * that declares a DOCTYPE or an ENTITY is refused outright (XXE / billion laughs).
 */
export function parseXml(source: string): XmlNode {
  if (source.length > LIMITS.bytes) throw new TaParseError('Berkas XMI lebih dari 5 MB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new TaParseError('XMI dengan DOCTYPE/ENTITY ditolak.');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  let nodes = 0;
  while ((m = tag.exec(source))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    if (m[6] !== undefined) {
      top.text += decode(m[6]);
      continue;
    }
    if (!m[3]) continue; // comment or processing instruction
    if (m[2] === '/') {
      if (stack.length < 2 || top.name !== m[3]) throw new TaParseError('XMI tidak well-formed.');
      stack.pop();
      continue;
    }
    if (++nodes > 200000) throw new TaParseError('XMI terlalu kompleks.');
    const node: XmlNode = { name: m[3], attrs: {}, children: [], text: '' };
    let a: RegExpExecArray | null;
    attr.lastIndex = 0;
    while ((a = attr.exec(m[4] ?? ''))) node.attrs[a[1]!] = decode(a[2] ?? a[3] ?? '');
    top.children.push(node);
    if (m[5] !== '/') {
      if (stack.length > 64) throw new TaParseError('XMI terlalu dalam.');
      stack.push(node);
    }
  }
  if (stack.length !== 1) throw new TaParseError('XMI tidak well-formed.');
  return root;
}
function* walk(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}
const local = (name: string) => name.replace(/^.*:/, '');

/**
 * Sparx "Publish > Export XMI" (XMI 2.1, EA extension included). Elements come from
 * uml:model packagedElements; stereotypes, notes, status and tagged values from the
 * <xmi:Extension extender="Enterprise Architect"> block, where Sparx keeps them;
 * connectors from the extension's <connectors>.
 */
export function parseSparxXmi(source: string): TaParseResult {
  const doc = parseXml(source);
  const skipped: string[] = [];
  const model = new Map<string, { type: string; name: string }>();
  let extension: XmlNode | undefined;
  for (const n of walk(doc)) {
    if (
      local(n.name) === 'packagedElement' &&
      n.attrs['xmi:id'] &&
      n.attrs['xmi:type'] !== 'uml:Package'
    )
      model.set(n.attrs['xmi:id'], { type: n.attrs['xmi:type'] ?? '', name: n.attrs.name ?? '' });
    if (local(n.name) === 'Extension' && /enterprise architect/i.test(n.attrs.extender ?? ''))
      extension = n;
  }
  if (!extension) throw new TaParseError('Bukan ekspor XMI Sparx EA (blok Extension tidak ada).');
  const elements: TaElementInput[] = [];
  const idToGuid = new Map<string, string>();
  const elementsNode = extension.children.find((c) => c.name === 'elements');
  for (const el of elementsNode?.children ?? []) {
    if (el.name !== 'element') continue;
    const id = el.attrs['xmi:idref'] ?? '';
    const type = el.attrs['xmi:type'] ?? model.get(id)?.type ?? '';
    if (type === 'uml:Package') continue;
    const props = el.children.find((c) => c.name === 'properties')?.attrs ?? {};
    const project = el.children.find((c) => c.name === 'project')?.attrs ?? {};
    const name = clean(el.attrs.name ?? model.get(id)?.name ?? '', 200);
    const tags: Record<string, string> = {};
    for (const t of el.children.find((c) => c.name === 'tags')?.children ?? [])
      if (t.name === 'tag' && t.attrs.name)
        tags[t.attrs.name] = (t.attrs.value ?? '').replace(/#NOTES#.*$/s, '');
    const kind = kindFromSparx(type, props.stereotype ?? '', tags.kind ?? '');
    if (!name || !id) continue;
    if (!kind) {
      skipped.push(
        `${name} (${type}${props.stereotype ? ' «' + props.stereotype + '»' : ''}): bukan elemen Technology Architecture, dilewati.`,
      );
      continue;
    }
    // EA's own GUID is the stable id; the xmi:id (EAID_...) is derived from it.
    const guid = clean(
      tags.guid ?? project.guid ?? id.replace(/^EAID_/, '').replace(/_/g, '-'),
      80,
    );
    idToGuid.set(id, guid);
    elements.push(
      elementFrom(
        guid,
        kind,
        name,
        props.status ?? project.status ?? '',
        props.documentation ?? '',
        tags,
        skipped,
      ),
    );
  }
  const relations: TaRelationInput[] = [];
  const connectorsNode = extension.children.find((c) => c.name === 'connectors');
  for (const c of connectorsNode?.children ?? []) {
    if (c.name !== 'connector') continue;
    const source = c.children.find((x) => x.name === 'source')?.attrs['xmi:idref'] ?? '';
    const target = c.children.find((x) => x.name === 'target')?.attrs['xmi:idref'] ?? '';
    const props = c.children.find((x) => x.name === 'properties')?.attrs ?? {};
    const mapped = relationFromSparx(props.ea_type ?? '', props.stereotype ?? '');
    const s = idToGuid.get(source);
    const t = idToGuid.get(target);
    if (!s || !t) continue; // a connector to a non-TA element (a business actor, a note)
    if (!mapped) {
      skipped.push(
        `Konektor ${props.ea_type ?? '?'}${props.stereotype ? ' «' + props.stereotype + '»' : ''} tidak dipetakan.`,
      );
      continue;
    }
    relations.push({
      externalId: clean(c.attrs['xmi:idref'] ?? '', 80) || null,
      sourceExternalId: mapped.swap ? t : s,
      targetExternalId: mapped.swap ? s : t,
      kind: mapped.kind,
    });
  }
  return finish({ elements, relations, skipped });
}

// --- CSV template --------------------------------------------------------------------------

/** RFC 4180 with a leading BOM tolerated; returns rows of cells. */
export function parseCsv(source: string): string[][] {
  if (source.length > LIMITS.bytes) throw new TaParseError('Berkas CSV lebih dari 5 MB.');
  const text = source.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',' || ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (quoted) throw new TaParseError('CSV: tanda kutip tidak ditutup.');
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
export const TA_CSV_ELEMENT_HEADER = [
  'GUID',
  'Type',
  'Stereotype',
  'Name',
  'Status',
  'Notes',
  'hostname',
  'ip_address',
  'environment',
  'location',
  'os',
  'os_version',
  'owner',
  'end_of_support',
];
export const TA_CSV_RELATION_HEADER = ['GUID', 'SourceGUID', 'TargetGUID', 'Type', 'Stereotype'];
/**
 * The CSV template: an element sheet shaped like Sparx's CSV export spec (GUID, Type,
 * Stereotype, Name, Status, Notes, then tagged values as columns), optionally a second
 * section after a line "#relations" with SourceGUID, TargetGUID, Type, Stereotype.
 */
export function parseTaCsv(source: string): TaParseResult {
  const rows = parseCsv(source);
  const skipped: string[] = [];
  const split = rows.findIndex((r) => r[0]?.trim().toLowerCase() === '#relations');
  const elementRows = split >= 0 ? rows.slice(0, split) : rows;
  const relationRows = split >= 0 ? rows.slice(split + 1) : [];
  const [header, ...body] = elementRows;
  if (!header) throw new TaParseError('CSV kosong.');
  const cols = header.map((h) => h.trim().toLowerCase());
  const at = (r: string[], name: string) => r[cols.indexOf(name.toLowerCase())] ?? '';
  for (const need of ['guid', 'type', 'name'])
    if (!cols.includes(need)) throw new TaParseError(`CSV: kolom "${need}" wajib ada.`);
  const elements: TaElementInput[] = [];
  for (const r of body) {
    const name = clean(at(r, 'Name'), 200);
    const guid = clean(at(r, 'GUID'), 80).replace(/[{}]/g, '');
    if (!name || !guid) continue;
    const kind = kindFromSparx(at(r, 'Type'), at(r, 'Stereotype'), at(r, 'kind'));
    if (!kind) {
      skipped.push(`${name} (${at(r, 'Type')}): bukan elemen Technology Architecture, dilewati.`);
      continue;
    }
    const tags: Record<string, string> = {};
    cols.forEach((c, i) => {
      if (!['guid', 'type', 'stereotype', 'name', 'status', 'notes'].includes(c))
        tags[header[i]!.trim()] = r[i] ?? '';
    });
    elements.push(elementFrom(guid, kind, name, at(r, 'Status'), at(r, 'Notes'), tags, skipped));
  }
  const relations: TaRelationInput[] = [];
  const [rHeader, ...rBody] = relationRows;
  if (rHeader) {
    const rc = rHeader.map((h) => h.trim().toLowerCase());
    const get = (r: string[], n: string) => r[rc.indexOf(n)] ?? '';
    for (const r of rBody) {
      const mapped = relationFromSparx(get(r, 'type'), get(r, 'stereotype'));
      const s = clean(get(r, 'sourceguid'), 80).replace(/[{}]/g, '');
      const t = clean(get(r, 'targetguid'), 80).replace(/[{}]/g, '');
      if (!s || !t) continue;
      if (!mapped) {
        skipped.push(`Relasi ${get(r, 'type')} tidak dipetakan.`);
        continue;
      }
      relations.push({
        externalId: clean(get(r, 'guid'), 80).replace(/[{}]/g, '') || null,
        sourceExternalId: mapped.swap ? t : s,
        targetExternalId: mapped.swap ? s : t,
        kind: mapped.kind,
      });
    }
  }
  return finish({ elements, relations, skipped });
}

/** One entry point: XMI when it looks like XML, the CSV template otherwise. */
export function parseTaImport(
  filename: string,
  source: string,
): TaParseResult & { format: 'xmi' | 'csv' } {
  const xml = /\.(xmi|xml)$/i.test(filename) || /^\s*(﻿)?<\?xml|^\s*<xmi:XMI/i.test(source);
  if (xml) return { ...parseSparxXmi(source), format: 'xmi' };
  if (/\.csv$/i.test(filename)) return { ...parseTaCsv(source), format: 'csv' };
  throw new TaParseError(
    'Format tidak dikenal: gunakan ekspor XMI Sparx (.xmi/.xml) atau template CSV.',
  );
}

// --- the graph -----------------------------------------------------------------------------

export interface TaElement {
  id: string;
  externalId: string | null;
  kind: TaKind;
  name: string;
  hostname: string | null;
  ipAddress: string | null;
  environment: TaEnvironment | null;
  location: string | null;
  os: string | null;
  osVersion: string | null;
  status: TaStatus;
  owner: string | null;
  endOfSupport: string | null;
  description: string;
  attributes: Record<string, string>;
}
export interface TaRelation {
  id: string;
  sourceId: string;
  targetId: string;
  kind: TaRelationKind;
}
/** Edge list "a depends on b", derived from each relation's `dependent` end. */
function dependencyEdges(relations: readonly TaRelation[]) {
  return relations.map((r) =>
    TA_RELATIONS[r.kind].dependent === 'source'
      ? { dependent: r.sourceId, dependency: r.targetId, relation: r }
      : { dependent: r.targetId, dependency: r.sourceId, relation: r },
  );
}
export interface TaReach {
  id: string;
  /** Hops from the element asked about; 1 is a direct neighbour. */
  depth: number;
  /** The element one step closer to the start, to draw the path. */
  via: string;
}
function reach(
  start: string,
  relations: readonly TaRelation[],
  direction: 'up' | 'down',
): TaReach[] {
  const edges = dependencyEdges(relations);
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const from = direction === 'down' ? e.dependency : e.dependent;
    const to = direction === 'down' ? e.dependent : e.dependency;
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const seen = new Map<string, TaReach>();
  let frontier = [start];
  for (let depth = 1; frontier.length && depth <= 12; depth++) {
    const following: string[] = [];
    for (const from of frontier)
      for (const to of next.get(from) ?? [])
        if (to !== start && !seen.has(to)) {
          seen.set(to, { id: to, depth, via: from });
          following.push(to);
        }
    frontier = following;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth);
}
/** What stops working if `id` fails: everything that (transitively) depends on it. */
export const impactOf = (id: string, relations: readonly TaRelation[]) =>
  reach(id, relations, 'down');
/** What `id` needs in order to work: everything it (transitively) depends on. */
export const dependenciesOf = (id: string, relations: readonly TaRelation[]) =>
  reach(id, relations, 'up');

/** Days from `today` to the element's end of support; negative when already past. */
export function daysToEndOfSupport(e: Pick<TaElement, 'endOfSupport'>, today: Date): number | null {
  if (!e.endOfSupport) return null;
  const end = Date.parse(`${e.endOfSupport}T00:00:00Z`);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - now) / 86_400_000);
}

// --- questions -----------------------------------------------------------------------------

export type TaAnswer =
  | {
      type: 'impact';
      subject: TaElement;
      items: Array<TaReach & { element: TaElement }>;
      text: string;
    }
  | {
      type: 'dependencies';
      subject: TaElement;
      items: Array<TaReach & { element: TaElement }>;
      text: string;
    }
  | { type: 'element'; subject: TaElement; text: string }
  | { type: 'list'; filter: string; items: TaElement[]; text: string }
  | { type: 'none'; text: string };

const KIND_WORDS: Array<[RegExp, TaKind]> = [
  [/\b(vm|virtual machine|mesin virtual)s?\b/, 'virtual_machine'],
  [/\bserver fisik|physical server|host fisik|hypervisor\b/, 'server'],
  [
    /\b(switch|router|firewall|load ?balancer|perangkat jaringan|network device)s?\b/,
    'network_device',
  ],
  [/\b(storage|san|nas)\b/, 'storage'],
  [/\b(segmen|segment|vlan|subnet|jaringan)\b/, 'network_segment'],
  [/\b(database|dbms|platform|os|sistem operasi|middleware)\b/, 'platform'],
  [/\b(aplikasi|software|application)s?\b/, 'software'],
  [/\b(lokasi|data ?center|site)\b/, 'location'],
  [/\bserver\b/, 'server'],
];
const tokenise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}.\-_ ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Elements the question names by hostname, IP, or name; longest names first so "srv-db-01" beats "db". */
export function mentionedElements(question: string, elements: readonly TaElement[]): TaElement[] {
  const q = ` ${question.toLowerCase()} `;
  const tokens = new Set(tokenise(question));
  const hits = new Map<string, { e: TaElement; score: number }>();
  for (const e of elements) {
    const keys = [e.hostname, e.ipAddress, e.name.toLowerCase()].filter(
      (k): k is string => !!k && k.length >= 3,
    );
    for (const k of keys) {
      const exact = k.includes(' ') ? q.includes(` ${k} `) || q.includes(k) : tokens.has(k);
      if (exact) hits.set(e.id, { e, score: Math.max(hits.get(e.id)?.score ?? 0, k.length) });
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score).map((h) => h.e);
}

/**
 * Deterministic answers for the questions a Technology Architecture model exists to
 * answer: impact ("apa dampaknya jika X mati"), dependencies ("X butuh apa"), end of
 * support, inventory by kind / environment / location / OS, and "what is X". Anything
 * else returns `none` and the caller may try semantic search.
 */
export function answerTaQuestion(
  question: string,
  elements: readonly TaElement[],
  relations: readonly TaRelation[],
  today: Date,
): TaAnswer {
  const q = question.toLowerCase();
  const byId = new Map(elements.map((e) => [e.id, e]));
  const named = mentionedElements(question, elements);
  const subject = named[0];
  const withElements = (items: TaReach[]) =>
    items.map((r) => ({ ...r, element: byId.get(r.id)! })).filter((r) => r.element);

  if (
    subject &&
    /dampak|impact|terdampak|kena|mati|down|gagal|padam|offline|maintenance|restart|reboot/.test(q)
  ) {
    const items = withElements(impactOf(subject.id, relations));
    return {
      type: 'impact',
      subject,
      items,
      text: items.length
        ? `Jika ${subject.name} tidak tersedia, ${items.length} elemen ikut terdampak (${items.filter((i) => i.depth === 1).length} langsung).`
        : `Tidak ada elemen yang tercatat bergantung pada ${subject.name}.`,
    };
  }
  if (
    subject &&
    /bergantung|butuh|membutuhkan|depend|dependensi|berjalan di|di mana|dimana|host|runs? on/.test(
      q,
    )
  ) {
    const items = withElements(dependenciesOf(subject.id, relations));
    return {
      type: 'dependencies',
      subject,
      items,
      text: items.length
        ? `${subject.name} bergantung pada ${items.length} elemen.`
        : `${subject.name} tidak tercatat bergantung pada elemen lain.`,
    };
  }
  if (
    /end.?of.?(support|life)|eos|eol|usang|kedaluwarsa|tidak didukung|habis masa|masa dukungan|lifecycle|obsolete/.test(
      q,
    )
  ) {
    const horizon = /tahun ini|this year/.test(q)
      ? Math.max(
          0,
          Math.round((Date.UTC(today.getUTCFullYear(), 11, 31) - today.getTime()) / 86_400_000),
        )
      : /sudah|lewat|past|expired/.test(q)
        ? 0
        : 365;
    const items = elements
      .filter((e) => e.status !== 'retired')
      .map((e) => ({ e, d: daysToEndOfSupport(e, today) }))
      .filter((x): x is { e: TaElement; d: number } => x.d !== null && x.d <= horizon)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.e);
    const past = items.filter((e) => (daysToEndOfSupport(e, today) ?? 1) < 0).length;
    return {
      type: 'list',
      filter: horizon === 0 ? 'Sudah melewati end of support' : `End of support ≤ ${horizon} hari`,
      items,
      text: items.length
        ? `${items.length} elemen aktif ${horizon === 0 ? 'sudah melewati' : 'mendekati atau melewati'} end of support${past ? ` (${past} sudah lewat)` : ''}.`
        : 'Tidak ada elemen aktif yang mendekati end of support.',
    };
  }
  if (
    subject &&
    named.length === 1 &&
    !/berapa|jumlah|daftar|list|semua|mana saja|apa saja/.test(q)
  ) {
    return { type: 'element', subject, text: describe(subject, relations, byId) };
  }
  // Inventory: a kind, an environment, a location or an OS named in the question.
  const kind = KIND_WORDS.find(([re]) => re.test(q))?.[1];
  const env = /\bprod(uction)?\b/.test(q)
    ? 'production'
    : /\b(staging|uat)\b/.test(q)
      ? 'staging'
      : /\b(dev|development)\b/.test(q)
        ? 'development'
        : /\b(dr|drc|disaster)\b/.test(q)
          ? 'dr'
          : null;
  const locations = [...new Set(elements.map((e) => e.location).filter((l): l is string => !!l))];
  const location = locations.find(
    (l) => q.includes(l.toLowerCase()) || tokenise(l).some((t) => t.length > 3 && q.includes(t)),
  );
  // An OS counts as named when the whole name appears, or its distinctive first word
  // ("windows", "ubuntu", "centos") does -- never a generic word like "server".
  const GENERIC = new Set(['server', 'linux', 'enterprise', 'system', 'software', 'edition']);
  const qTokens = tokenise(q);
  const oses = [...new Set(elements.map((e) => e.os).filter((o): o is string => !!o))];
  const os = oses.find((o) => {
    const first = tokenise(o)[0] ?? '';
    return (
      q.includes(o.toLowerCase()) ||
      (first.length >= 4 && !GENERIC.has(first) && qTokens.includes(first))
    );
  });
  // A kind alone ("server untuk monitoring") is a description, not an inventory request:
  // only list when the question asks for a list or names an environment, place or OS.
  const listCue = /berapa|jumlah|daftar|list|semua|mana saja|apa saja|inventori|inventory/.test(q);
  if ((kind && listCue) || env || location || os) {
    const items = elements.filter(
      (e) =>
        e.status !== 'retired' &&
        (!kind || e.kind === kind) &&
        (!env || e.environment === env) &&
        (!location || e.location === location) &&
        (!os || (e.os ?? '').toLowerCase().includes(os.toLowerCase())),
    );
    const parts = [
      kind && TA_KIND_LABELS[kind].toLowerCase(),
      env && `lingkungan ${TA_ENVIRONMENT_LABELS[env]}`,
      location && `di ${location}`,
      os && `ber-OS ${os}`,
    ].filter(Boolean);
    return {
      type: 'list',
      filter: parts.join(', '),
      items,
      text: `${items.length} elemen aktif: ${parts.join(', ')}.`,
    };
  }
  if (subject) return { type: 'element', subject, text: describe(subject, relations, byId) };
  return {
    type: 'none',
    text: 'Pertanyaan ini tidak cocok dengan data arsitektur yang tercatat. Sebut nama/hostname elemen, atau tanyakan dampak, dependensi, end of support, atau inventori.',
  };
}
function describe(
  e: TaElement,
  relations: readonly TaRelation[],
  byId: Map<string, TaElement>,
): string {
  const facts = [
    TA_KIND_LABELS[e.kind],
    e.hostname && `hostname ${e.hostname}`,
    e.ipAddress && `IP ${e.ipAddress}`,
    e.environment && TA_ENVIRONMENT_LABELS[e.environment],
    e.os && `${e.os}${e.osVersion ? ' ' + e.osVersion : ''}`,
    e.location && `lokasi ${e.location}`,
    e.owner && `pemilik ${e.owner}`,
    e.endOfSupport && `end of support ${e.endOfSupport}`,
  ].filter(Boolean);
  const out = relations
    .filter((r) => r.sourceId === e.id)
    .map((r) => `${TA_RELATIONS[r.kind].label} ${byId.get(r.targetId)?.name ?? '?'}`);
  return `${e.name}: ${facts.join(', ')}.${out.length ? ' ' + out.slice(0, 6).join('; ') + '.' : ''}`;
}

/**
 * The Markdown card a search index receives for one element: facts and neighbours in
 * words, so "server untuk aplikasi absensi" can find srv-app-02 by meaning. It is an
 * index of this data, never a source: answers still come from the database.
 */
export function elementCard(
  e: TaElement,
  relations: readonly TaRelation[],
  byId: Map<string, TaElement>,
): string {
  const lines = [
    `# ${e.name}`,
    '',
    `Jenis: ${TA_KIND_LABELS[e.kind]}. Status: ${TA_STATUS_LABELS[e.status]}.`,
    e.hostname ? `Hostname: ${e.hostname}.` : '',
    e.ipAddress ? `Alamat IP: ${e.ipAddress}.` : '',
    e.environment ? `Lingkungan: ${TA_ENVIRONMENT_LABELS[e.environment]}.` : '',
    e.os ? `Sistem operasi / platform: ${e.os}${e.osVersion ? ' ' + e.osVersion : ''}.` : '',
    e.location ? `Lokasi: ${e.location}.` : '',
    e.owner ? `Pemilik: ${e.owner}.` : '',
    e.endOfSupport ? `End of support: ${e.endOfSupport}.` : '',
    e.description ? `\n${e.description}` : '',
    '',
    '## Relasi',
    ...relations
      .filter((r) => r.sourceId === e.id || r.targetId === e.id)
      .map((r) =>
        r.sourceId === e.id
          ? `- ${e.name} ${TA_RELATIONS[r.kind].label} ${byId.get(r.targetId)?.name ?? '?'}`
          : `- ${e.name} ${TA_RELATIONS[r.kind].inverse} ${byId.get(r.sourceId)?.name ?? '?'}`,
      ),
  ];
  return (
    lines
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n')
      .trim() + '\n'
  );
}
