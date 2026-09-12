-- S07/V1: "saran perapian taksonomi" -- labels that look like duplicates, and labels
-- nobody uses. Trigram similarity needs pg_trgm; the aggregate itself runs under the
-- actor's own RLS in packages/db/src/taxonomy.ts, so it only ever compares labels in
-- categories the actor can see. Nothing here changes data: merging stays the explicit
-- app.merge_labels() call with its revision check.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT EXECUTE ON FUNCTION public.similarity(text,text) TO intradocs_app;

-- "Unused" must mean unused by ANY active version, not by the ones this admin may read:
-- app.is_active_version() includes app.can_read_version(), so a label carried only by a
-- restricted document the admin cannot open would look unused and get deleted. Counts
-- come from a definer function over the publication predicate alone -- counts only, no
-- titles, and only for labels the caller can already see (joined under their own RLS).
CREATE FUNCTION app.label_usage_counts() RETURNS TABLE(label_id uuid, used_by bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT l.id, count(v.id)
 FROM app.labels l
 LEFT JOIN app.document_versions v
   ON v.category_id=l.category_id AND l.name=ANY(v.labels)
  AND EXISTS(SELECT 1 FROM app.documents d WHERE d.current_version_id=v.id AND NOT d.withdrawn)
  AND v.review_state='approved' AND v.processing_state='ready' AND v.publication_state='published'
  AND (v.expires_at IS NULL OR v.expires_at>now())
 GROUP BY l.id
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.label_usage_counts() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.label_usage_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.label_usage_counts() TO intradocs_app;
GRANT SELECT ON app.labels,app.document_versions,app.documents TO intradocs_workflow;
DO $$ BEGIN
 IF NOT has_table_privilege('intradocs_workflow','app.labels','SELECT')
    OR NOT has_table_privilege('intradocs_workflow','app.document_versions','SELECT') THEN
  RAISE EXCEPTION 'label_usage_counts cannot read its tables';
 END IF;
END $$;
