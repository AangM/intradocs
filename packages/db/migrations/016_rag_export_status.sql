-- pnpm weknora:status and weknora:sync reported queue counts with a direct SELECT on
-- app.rag_export_queue as the worker role, which fails: that role deliberately holds no
-- table privileges. Granting SELECT would weaken the boundary for a progress line, so the
-- counts come from a fixed SECURITY DEFINER function instead. It exposes aggregates only
-- -- no titles, no IDs, nothing about which documents are involved.
CREATE FUNCTION app.rag_export_status() RETURNS TABLE(state text,total bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT q.state,count(*) FROM app.rag_export_queue q GROUP BY q.state
 UNION ALL
 SELECT 'indexed',count(*) FROM app.rag_index_entries
 ORDER BY 1
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.rag_export_status() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.rag_export_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rag_export_status() TO intradocs_worker;
