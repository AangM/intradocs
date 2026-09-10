-- Deleting a document version cascades away its app.rag_index_entries row (migration
-- 017), which is correct for the database but removes the knowledge_id before the
-- exporter can issue the matching delete to WeKnora. The record is then orphaned there:
-- observed after one HTTP test run, which deletes versions during cleanup, leaving four
-- WeKnora records with no owner in IntraDocs.
--
-- Retrieval was never affected -- an orphan carries no rag_index_entries row, so it can
-- never be resolved into a citation. This is storage hygiene, not an access boundary.
--
-- The sweep needs to know which versions legitimately have an index record. The worker
-- role has no SELECT on business tables, so it gets a fixed function returning ids only.
CREATE FUNCTION app.rag_known_versions() RETURNS TABLE(version_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT e.version_id FROM app.rag_index_entries e
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.rag_known_versions() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.rag_known_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rag_known_versions() TO intradocs_worker;
