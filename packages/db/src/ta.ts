import { withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';
import type { TaElement, TaParseResult, TaRelation } from '@intradocs/core/ta';

type ElementRow = {
  id: string;
  external_id: string | null;
  category_id: string;
  kind: TaElement['kind'];
  name: string;
  hostname: string | null;
  ip_address: string | null;
  environment: TaElement['environment'];
  location: string | null;
  os: string | null;
  os_version: string | null;
  status: TaElement['status'];
  owner_label: string | null;
  end_of_support: Date | string | null;
  description: string;
  attributes: Record<string, string>;
  updated_at: Date;
};
export type TaElementRecord = TaElement & { categoryId: string; updatedAt: string };
const dateOnly = (v: Date | string | null) =>
  v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
export function mapElement(r: ElementRow): TaElementRecord {
  return {
    id: r.id,
    externalId: r.external_id,
    categoryId: r.category_id,
    kind: r.kind,
    name: r.name,
    hostname: r.hostname,
    ipAddress: r.ip_address,
    environment: r.environment,
    location: r.location,
    os: r.os,
    osVersion: r.os_version,
    status: r.status,
    owner: r.owner_label,
    endOfSupport: dateOnly(r.end_of_support),
    description: r.description,
    attributes: r.attributes ?? {},
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * The whole model this actor may see: RLS returns the elements and relations of their
 * categories only, so impact and dependency walks never cross into a category they
 * cannot read (an impact list is, by construction, "as far as you can see").
 */
export async function taModel(
  actorId: string,
): Promise<{ elements: TaElementRecord[]; relations: TaRelation[] }> {
  return withActor(actorId, async ({ client }) => {
    const elements = await client.query<ElementRow>(
      `SELECT id,external_id,category_id,kind,name,hostname,ip_address,environment,location,os,os_version,status,
              owner_label,end_of_support::text AS end_of_support,description,attributes,updated_at
       FROM app.ta_elements ORDER BY kind,name`,
    );
    const relations = await client.query<{
      id: string;
      source_id: string;
      target_id: string;
      kind: TaRelation['kind'];
    }>('SELECT id,source_id,target_id,kind FROM app.ta_relations');
    return {
      elements: elements.rows.map(mapElement),
      relations: relations.rows.map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        kind: r.kind,
      })),
    };
  });
}

export interface TaImportSummary {
  elements?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  relations?: number;
  relationsRemoved?: number;
  notInImport?: number;
  skipped: string[];
}
/** One element's change in a proposed import: new, or the fields that differ (old, new). */
export interface TaDiffEntry {
  externalId: string;
  name: string;
  kind: string;
  change: 'created' | 'updated';
  fields: Record<string, [unknown, unknown]>;
}
const FIELDS: Array<[keyof TaElementRecord & keyof TaElementInputLike, string]> = [
  ['kind', 'kind'],
  ['name', 'name'],
  ['hostname', 'hostname'],
  ['ipAddress', 'ipAddress'],
  ['environment', 'environment'],
  ['location', 'location'],
  ['os', 'os'],
  ['osVersion', 'osVersion'],
  ['status', 'status'],
  ['owner', 'owner'],
  ['endOfSupport', 'endOfSupport'],
  ['description', 'description'],
];
type TaElementInputLike = TaParseResult['elements'][number];
const sortedAttrs = (a: Record<string, string>) =>
  JSON.stringify(Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)));

/** The diff of a parsed import against the category as it is now (read as the actor). */
export async function diffTaImport(
  actorId: string,
  categoryId: string,
  parsed: TaParseResult,
): Promise<{ created: number; updated: number; unchanged: number; diff: TaDiffEntry[] }> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<ElementRow>(
      `SELECT id,external_id,category_id,kind,name,hostname,ip_address,environment,location,os,os_version,status,
              owner_label,end_of_support::text AS end_of_support,description,attributes,updated_at
       FROM app.ta_elements WHERE category_id=$1`,
      [categoryId],
    );
    const byGuid = new Map(rows.map((r) => [r.external_id, mapElement(r)]));
    const diff: TaDiffEntry[] = [];
    let unchanged = 0;
    for (const e of parsed.elements) {
      const old = byGuid.get(e.externalId);
      if (!old) {
        diff.push({
          externalId: e.externalId,
          name: e.name,
          kind: e.kind,
          change: 'created',
          fields: {},
        });
        continue;
      }
      const fields: Record<string, [unknown, unknown]> = {};
      for (const [key, label] of FIELDS)
        if ((old[key] ?? null) !== (e[key] ?? null))
          fields[label] = [old[key] ?? null, e[key] ?? null];
      if (sortedAttrs(old.attributes) !== sortedAttrs(e.attributes))
        fields.attributes = [old.attributes, e.attributes];
      if (Object.keys(fields).length)
        diff.push({
          externalId: e.externalId,
          name: e.name,
          kind: e.kind,
          change: 'updated',
          fields,
        });
      else unchanged++;
    }
    return {
      created: diff.filter((d) => d.change === 'created').length,
      updated: diff.filter((d) => d.change === 'updated').length,
      unchanged,
      diff,
    };
  });
}

/** Propose an import for review. The database checks role and scope and refuses a duplicate. */
export async function submitTaImport(
  actorId: string,
  input: {
    categoryId: string;
    parsed: TaParseResult;
    diff: TaDiffEntry[];
    filename: string;
    format: 'xmi' | 'csv';
    sha256: string;
    blobKey: string;
    scan: unknown;
  },
): Promise<string> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT app.ta_submit_import($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8::jsonb) AS id',
        [
          input.categoryId,
          JSON.stringify({
            elements: input.parsed.elements,
            relations: input.parsed.relations,
            skipped: input.parsed.skipped.slice(0, 200),
          }),
          JSON.stringify(input.diff.slice(0, 5000)),
          input.filename,
          input.format,
          input.sha256,
          input.blobKey,
          JSON.stringify(input.scan),
        ],
      );
      return rows[0]!.id;
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
/** Approve (applies the change set), reject (reason required) or withdraw (proposer only). */
export async function decideTaImport(
  actorId: string,
  importId: string,
  decision: 'approve' | 'reject' | 'withdraw',
  note: string | null,
): Promise<TaImportSummary & { state: string }> {
  try {
    return await withActor(actorId, async ({ client }) => {
      if (decision === 'withdraw') {
        await client.query('SELECT app.ta_withdraw_import($1)', [importId]);
        return { state: 'withdrawn', skipped: [] };
      }
      const { rows } = await client.query<{ result: TaImportSummary & { state: string } }>(
        'SELECT app.ta_decide_import($1,$2,$3) AS result',
        [importId, decision === 'approve', note],
      );
      return rows[0]!.result;
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

export interface TaImportRecord {
  id: string;
  categoryId: string;
  categoryName: string;
  filename: string;
  format: string;
  sha256: string;
  blobKey: string;
  state: 'pending' | 'applied' | 'rejected' | 'withdrawn';
  summary: TaImportSummary;
  diff: TaDiffEntry[];
  importedAt: string;
  importedById: string;
  importedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}
export async function listTaImports(actorId: string, limit = 30): Promise<TaImportRecord[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query(
      `SELECT i.id,i.category_id,c.name AS category_name,i.filename,i.format,i.sha256,i.blob_key,i.state,i.summary,
              CASE WHEN i.state='pending' THEN i.diff ELSE '[]'::jsonb END AS diff,
              i.imported_at,i.imported_by,i.decided_at,i.decision_note,
              (SELECT name FROM app.profiles p WHERE p.id=i.imported_by) AS imported_by_name,
              (SELECT name FROM app.profiles p WHERE p.id=i.decided_by) AS decided_by_name
       FROM app.ta_imports i JOIN app.categories c ON c.id=i.category_id
       ORDER BY (i.state='pending') DESC, i.imported_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      categoryId: r.category_id,
      categoryName: r.category_name,
      filename: r.filename,
      format: r.format,
      sha256: r.sha256,
      blobKey: r.blob_key,
      state: r.state,
      summary: r.summary,
      diff: r.diff,
      importedAt: r.imported_at.toISOString(),
      importedById: r.imported_by,
      importedBy: r.imported_by_name,
      decidedAt: r.decided_at?.toISOString() ?? null,
      decidedBy: r.decided_by_name,
      decisionNote: r.decision_note,
    }));
  });
}
export async function taImportFile(actorId: string, importId: string) {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{ blob_key: string; sha256: string; filename: string }>(
      'SELECT blob_key,sha256,filename FROM app.ta_imports WHERE id=$1',
      [importId],
    );
    return rows[0] ?? null;
  });
}
/** Proposals this actor may decide (not their own), for the sidebar badge. */
export async function taPendingCount(actorId: string): Promise<number> {
  return withActor(actorId, async ({ client }) =>
    Number((await client.query('SELECT app.ta_pending_for_actor() AS n')).rows[0]?.n ?? 0),
  );
}
/** Every approved change to one element: which import, who approved, which fields. */
export async function taElementChanges(actorId: string, elementId: string) {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query('SELECT * FROM app.ta_element_history($1)', [elementId]);
    return rows.map((r) => ({
      change: r.change as 'created' | 'updated',
      fields: r.fields as Record<string, [unknown, unknown]>,
      changedAt: r.changed_at.toISOString() as string,
      filename: r.filename as string,
      importId: r.import_id as string,
      proposedBy: r.proposed_by as string | null,
      approvedBy: r.approved_by as string | null,
    }));
  });
}
