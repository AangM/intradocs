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
  created: number;
  updated: number;
  unchanged: number;
  relations: number;
  relationsRemoved: number;
  notInImport: number;
  skipped: string[];
}
/** Applies a parsed import into one category, as the actor; the database checks the role and scope. */
export async function applyTaImport(
  actorId: string,
  input: {
    categoryId: string;
    parsed: TaParseResult;
    filename: string;
    format: 'xmi' | 'csv';
    sha256: string;
  },
): Promise<TaImportSummary> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ summary: TaImportSummary }>(
        'SELECT app.ta_apply_import($1,$2::jsonb,$3,$4,$5) AS summary',
        [
          input.categoryId,
          JSON.stringify({
            elements: input.parsed.elements,
            relations: input.parsed.relations,
            skipped: input.parsed.skipped.slice(0, 200),
          }),
          input.filename,
          input.format,
          input.sha256,
        ],
      );
      return rows[0]!.summary;
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

/** What an import would change, without changing anything: compared against the actor's view. */
export async function previewTaImport(
  actorId: string,
  categoryId: string,
  parsed: TaParseResult,
): Promise<{ created: number; updated: number; unchanged: number }> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<ElementRow>(
      `SELECT id,external_id,category_id,kind,name,hostname,ip_address,environment,location,os,os_version,status,
              owner_label,end_of_support::text AS end_of_support,description,attributes,updated_at
       FROM app.ta_elements WHERE category_id=$1`,
      [categoryId],
    );
    const byGuid = new Map(rows.map((r) => [r.external_id, mapElement(r)]));
    // jsonb does not keep key order; compare attributes as sorted pairs.
    const attrs = (a: Record<string, string>) =>
      Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1));
    let created = 0,
      updated = 0,
      unchanged = 0;
    for (const e of parsed.elements) {
      const old = byGuid.get(e.externalId);
      if (!old) created++;
      else if (
        JSON.stringify([
          old.kind,
          old.name,
          old.hostname,
          old.ipAddress,
          old.environment,
          old.location,
          old.os,
          old.osVersion,
          old.status,
          old.owner,
          old.endOfSupport,
          old.description,
          attrs(old.attributes),
        ]) !==
        JSON.stringify([
          e.kind,
          e.name,
          e.hostname,
          e.ipAddress,
          e.environment,
          e.location,
          e.os,
          e.osVersion,
          e.status,
          e.owner,
          e.endOfSupport,
          e.description,
          attrs(e.attributes),
        ])
      )
        updated++;
      else unchanged++;
    }
    return { created, updated, unchanged };
  });
}

export async function listTaImports(actorId: string) {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      filename: string;
      format: string;
      summary: TaImportSummary;
      imported_at: Date;
      by: string | null;
    }>(
      `SELECT i.id,i.filename,i.format,i.summary,i.imported_at,
              (SELECT name FROM app.profiles p WHERE p.id=i.imported_by) AS by
       FROM app.ta_imports i ORDER BY i.imported_at DESC LIMIT 20`,
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      format: r.format,
      summary: r.summary,
      importedAt: r.imported_at.toISOString(),
      by: r.by,
    }));
  });
}
