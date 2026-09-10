-- Fix for 010: the SECURITY DEFINER functions are owned by intradocs_workflow, but
-- BYPASSRLS only lifts row-level policies -- it does not grant table privileges. The
-- functions therefore failed with "permission denied for table rag_export_queue" the
-- first time they ran. Migration 004 grants these explicitly for its own tables; 010
-- omitted the equivalent grants for the two RAG tables.
-- DELETE on rag_export_queue is deliberately withheld: jobs are closed by state, never
-- removed, so the queue keeps an auditable history of every export attempt.
GRANT SELECT,INSERT,UPDATE ON app.rag_export_queue TO intradocs_workflow;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.rag_index_entries TO intradocs_workflow;
