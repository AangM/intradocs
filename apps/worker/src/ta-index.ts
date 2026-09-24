import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { WeknoraClient } from '@intradocs/core/weknora';
import { elementCard, type TaElement, type TaRelation } from '@intradocs/core/ta';

type Row = Record<string, unknown>;
const toElement = (r: Row): TaElement => ({
  id: String(r.id),
  externalId: (r.external_id as string) ?? null,
  kind: r.kind as TaElement['kind'],
  name: String(r.name),
  hostname: (r.hostname as string) ?? null,
  ipAddress: (r.ip_address as string) ?? null,
  environment: (r.environment as TaElement['environment']) ?? null,
  location: (r.location as string) ?? null,
  os: (r.os as string) ?? null,
  osVersion: (r.os_version as string) ?? null,
  status: r.status as TaElement['status'],
  owner: (r.owner_label as string) ?? null,
  endOfSupport: r.end_of_support ? String(r.end_of_support).slice(0, 10) : null,
  description: String(r.description ?? ''),
  attributes: (r.attributes as Record<string, string>) ?? {},
});

/**
 * One pass: every element whose card is new or changed is written to the TA knowledge
 * base (at most `limit` per pass) and recorded. The card is an index; the element row
 * stays the source. Returns how many cards were written.
 */
export async function syncTaIndex(pool: Pool, client: WeknoraClient, limit = 25): Promise<number> {
  const { rows } = await pool.query<{ elements: Row[]; relations: Row[]; entries: Row[] }>(
    'SELECT * FROM app.ta_index_snapshot()',
  );
  const snap = rows[0];
  if (!snap) return 0;
  const elements = snap.elements.map(toElement);
  const relations: TaRelation[] = snap.relations.map((r) => ({
    id: String(r.id),
    sourceId: String(r.source_id),
    targetId: String(r.target_id),
    kind: r.kind as TaRelation['kind'],
  }));
  const entries = new Map(snap.entries.map((e) => [String(e.element_id), e]));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const written: string[] = [];
  for (const e of elements) {
    if (written.length >= limit) break;
    const card = elementCard(e, relations, byId);
    const sha = createHash('sha256').update(card).digest('hex');
    const entry = entries.get(e.id);
    if (entry && entry.card_sha256 === sha) continue;
    // The title carries the element id: a search hit maps back to a row, never to text.
    const title = `ta:${e.id} ${e.name}`;
    let knowledgeId = entry ? String(entry.knowledge_id) : '';
    if (knowledgeId) await client.updateManualKnowledge(knowledgeId, { title, content: card });
    else knowledgeId = await client.createManualKnowledge({ title, content: card });
    await pool.query('SELECT app.ta_index_record($1,$2,$3)', [e.id, knowledgeId, sha]);
    written.push(knowledgeId);
  }
  if (written.length) await client.reparseKnowledge(written);
  return written.length;
}
