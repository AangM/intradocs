import { withActor } from './index.ts';
import type { CatalogQuery } from '@intradocs/core/validation';
import type { DocumentItem } from './queries.ts';
export type SearchItem = DocumentItem & { snippet: string };
export async function searchDocuments(
  actorId: string,
  q: CatalogQuery,
): Promise<{ items: SearchItem[]; total: number; pageSize: number; durationMs: number }> {
  const started = performance.now();
  return withActor(actorId, async ({ client }) => {
    const values = [
      q.q,
      q.category,
      q.label ?? null,
      q.format ?? null,
      q.owner ?? null,
      q.after ?? null,
    ];
    const source = `FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id JOIN app.categories c ON c.id=v.category_id
    LEFT JOIN LATERAL(SELECT content,ts_rank(search_vector,websearch_to_tsquery('simple',$1)) AS rank FROM app.lexical_chunks ch WHERE ch.version_id=v.id AND ch.search_vector@@websearch_to_tsquery('simple',$1) ORDER BY rank DESC,ch.ordinal LIMIT 1) hit ON true`;
    const where = `WHERE app.is_active_version(v.id) AND ($1='' OR position(lower($1) in lower(v.title||' '||v.summary))>0 OR hit.content IS NOT NULL)
    AND ($2::uuid IS NULL OR v.category_id=$2) AND ($3::text IS NULL OR $3=ANY(v.labels)) AND ($4::text IS NULL OR v.source_format=$4) AND ($5::text IS NULL OR d.owner_id=$5) AND ($6::timestamptz IS NULL OR v.created_at>=$6)`;
    const total = Number(
      (await client.query<{ n: string }>(`SELECT count(*) AS n ${source} ${where}`, values)).rows[0]
        ?.n ?? 0,
    );
    const { rows } = await client.query(
      `SELECT d.id,d.slug,d.owner_id,d.owner_label,v.*,c.name AS category_name,left(coalesce(hit.content,v.summary),280) AS snippet
    ${source} ${where} ORDER BY ${q.sort === 'title' ? 'v.title ASC' : "(CASE WHEN $1<>'' AND position(lower($1) in lower(v.title))>0 THEN 1 ELSE 0 END) DESC,coalesce(hit.rank,0) DESC,v.created_at DESC"},d.id LIMIT $7 OFFSET $8`,
      [...values, 8, (q.page - 1) * 8],
    );
    const durationMs = Math.round(performance.now() - started);
    if (q.q && q.page === 1)
      await client.query(
        'INSERT INTO app.search_events(actor_id,result_count,duration_ms) VALUES(app.actor_id(),$1,$2)',
        [total, durationMs],
      );
    return {
      items: rows.map((r) => ({
        id: r.document_id,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        categoryId: r.category_id,
        categoryName: r.category_name,
        classification: r.classification,
        labels: r.labels,
        ownerLabel: r.owner_label,
        ownerId: r.owner_id,
        versionId: r.id,
        versionLabel: r.label,
        format: r.source_format,
        bytes: r.byte_size,
        updatedAt: r.created_at.toISOString(),
        status: 'published' as const,
        expiresAt: r.expires_at?.toISOString() ?? null,
        snippet: r.snippet,
      })),
      total,
      pageSize: 8,
      durationMs,
    };
  });
}
export async function discoveryOptions(actorId: string) {
  return withActor(actorId, async ({ client }) => {
    const labels = (
      await client.query<{ name: string }>(
        `SELECT DISTINCT unnest(v.labels) AS name FROM app.document_versions v WHERE app.is_active_version(v.id) ORDER BY name LIMIT 100`,
      )
    ).rows.map((r) => r.name);
    const owners = (
      await client.query<{ id: string; name: string }>(
        `SELECT DISTINCT d.owner_id AS id,d.owner_label AS name FROM app.documents d WHERE app.is_active_version(d.current_version_id) ORDER BY name LIMIT 100`,
      )
    ).rows;
    return { labels, owners };
  });
}
export async function dashboardData(actorId: string, days = 30, unit: string | null = null) {
  return withActor(actorId, async ({ client }) => {
    const summary = (
      await client.query(
        `SELECT count(*) FILTER(WHERE app.is_active_version(d.current_version_id))::int AS active,count(*) FILTER(WHERE v.review_state='in_review')::int AS reviewing,count(*) FILTER(WHERE v.review_state IN ('draft','changes_requested'))::int AS drafts,count(*) FILTER(WHERE v.expires_at<=now())::int AS expired FROM app.documents d JOIN LATERAL(SELECT * FROM app.document_versions v0 WHERE v0.document_id=d.id ORDER BY v0.version_number DESC LIMIT 1) v ON true WHERE ($1::text IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=d.owner_id AND p.unit=$1))`,
        [unit],
      )
    ).rows[0];
    const activity = (
      await client.query<{ day: string; reads: number }>(
        `SELECT to_char(a.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS day,count(*)::int AS reads FROM app.audit_events a WHERE a.action='document.read' AND a.created_at>=now()-make_interval(days=>$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM app.documents d JOIN app.profiles p ON p.id=d.owner_id WHERE d.id=a.document_id AND p.unit=$2)) GROUP BY 1 ORDER BY 1`,
        [days, unit],
      )
    ).rows;
    const search = (
      await client.query<{ total: number; zero: number; avg_ms: number | null }>(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE result_count=0)::int AS zero,round(avg(duration_ms))::int AS avg_ms FROM app.search_events s WHERE created_at>=now()-make_interval(days=>$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=s.actor_id AND p.unit=$2))`,
        [days, unit],
      )
    ).rows[0]!;
    const approval = (
      await client.query<{ hours: number | null }>(
        `SELECT round(avg(extract(epoch FROM(decided_at-submitted_at))/3600)::numeric,2)::float AS hours FROM app.approval_requests r WHERE state='approved' AND decided_at>=now()-make_interval(days=>$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM app.documents d JOIN app.profiles p ON p.id=d.owner_id WHERE d.id=r.document_id AND p.unit=$2))`,
        [days, unit],
      )
    ).rows[0]!;
    const contributors = (
      await client.query<{ name: string; total: number }>(
        `SELECT d.owner_label AS name,count(*)::int AS total FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE app.is_active_version(v.id) AND v.approved_at>=now()-make_interval(days=>$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=d.owner_id AND p.unit=$2)) GROUP BY d.owner_id,d.owner_label ORDER BY total DESC,d.owner_label LIMIT 5`,
        [days, unit],
      )
    ).rows;
    const units = (
      await client.query<{ unit: string }>(
        `SELECT DISTINCT p.unit FROM app.profiles p WHERE EXISTS(SELECT 1 FROM app.documents d WHERE d.owner_id=p.id) ORDER BY p.unit LIMIT 100`,
      )
    ).rows.map((r) => r.unit);
    const latest = (
      await client.query<{ id: string; slug: string; title: string; format: string }>(
        `SELECT d.id,d.slug,v.title,v.source_format AS format FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE app.is_active_version(v.id) AND v.approved_at>=now()-make_interval(days=>$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=d.owner_id AND p.unit=$2)) ORDER BY v.approved_at DESC,d.id LIMIT 5`,
        [days, unit],
      )
    ).rows;
    return {
      summary: {
        active: Number(summary.active),
        reviewing: Number(summary.reviewing),
        drafts: Number(summary.drafts),
        expired: Number(summary.expired),
      },
      activity,
      search,
      approvalHours: approval.hours,
      contributors,
      units,
      latest,
    };
  });
}
export async function relatedDocuments(actorId: string, documentId: string, categoryId: string) {
  return withActor(
    actorId,
    async ({ client }) =>
      (
        await client.query<{ id: string; slug: string; title: string; format: string }>(
          `SELECT d.id,d.slug,v.title,v.source_format AS format FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE d.id<>$1 AND v.category_id=$2 AND app.is_active_version(v.id) ORDER BY v.approved_at DESC,d.id LIMIT 3`,
          [documentId, categoryId],
        )
      ).rows,
  );
}
export async function mostRead(actorId: string) {
  return withActor(actorId, async ({ client }) => {
    // A fixed function aggregates only documents currently visible to the caller.
    const { rows } = await client.query<{ id: string; slug: string; title: string; reads: number }>(
      'SELECT * FROM app.most_read_documents()',
    );
    return rows;
  });
}
