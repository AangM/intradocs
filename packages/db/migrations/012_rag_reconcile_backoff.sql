-- Fix for 010: the blanket ON CONFLICT DO UPDATE reset attempts, available_at and
-- error_code on every pass, so a repeatedly failing export had its backoff erased each
-- reconciliation and could never reach 'dead'. Measured before this fix: a job at
-- attempts=3 with a 300s backoff was returned to attempts=0, available_at=now().
--
-- Reset now happens only when the work actually changed:
--   * operation differs      -> re-open even from 'dead', because a revoke turning an
--                               'upsert' into a 'remove' must never be blocked by a
--                               previously exhausted export job
--   * state done/cancelled   -> genuinely new work (the upsert branch only selects a
--                               version whose indexed source_hash no longer matches)
-- Otherwise the existing row is left alone, so pending backoff and dead state survive.
-- 'running' is still never disturbed; the next pass picks up any change.
CREATE OR REPLACE FUNCTION app.reconcile_rag_exports() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE queued integer:=0; n integer; BEGIN
 PERFORM pg_advisory_xact_lock(719284,1);
 INSERT INTO app.rag_export_queue(version_id,operation)
  SELECT v.id,'upsert' FROM app.document_versions v
  WHERE app.is_indexable_version(v.id)
   AND NOT EXISTS(SELECT 1 FROM app.rag_index_entries e WHERE e.version_id=v.id AND e.source_hash=v.markdown_sha256)
 ON CONFLICT(version_id) DO UPDATE SET operation='upsert',state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL
  WHERE rag_export_queue.state<>'running'
   AND (rag_export_queue.operation<>'upsert' OR rag_export_queue.state IN ('done','cancelled'));
 GET DIAGNOSTICS n=ROW_COUNT; queued:=queued+n;
 INSERT INTO app.rag_export_queue(version_id,operation)
  SELECT e.version_id,'remove' FROM app.rag_index_entries e WHERE NOT app.is_indexable_version(e.version_id)
 ON CONFLICT(version_id) DO UPDATE SET operation='remove',state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL
  WHERE rag_export_queue.state<>'running'
   AND (rag_export_queue.operation<>'remove' OR rag_export_queue.state IN ('done','cancelled'));
 GET DIAGNOSTICS n=ROW_COUNT; queued:=queued+n;
 RETURN queued; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.reconcile_rag_exports() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.reconcile_rag_exports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_rag_exports() TO intradocs_worker;
