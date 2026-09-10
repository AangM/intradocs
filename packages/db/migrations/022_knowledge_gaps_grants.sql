-- Fix for 020, the same class of mistake migration 011 corrected for the RAG tables:
-- app.knowledge_gaps() and app.prune_search_queries() are SECURITY DEFINER owned by
-- intradocs_workflow, and BYPASSRLS lifts row-level policies but grants no table
-- privileges. Both failed with "permission denied for table search_events" the first
-- time they ran. 020 granted UPDATE(query_norm) but not the SELECT the aggregate needs.
GRANT SELECT ON app.search_events TO intradocs_workflow;
DO $$ BEGIN
 IF NOT has_table_privilege('intradocs_workflow','app.search_events','SELECT') THEN
  RAISE EXCEPTION 'knowledge_gaps cannot read search_events';
 END IF;
END $$;
