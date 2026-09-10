-- The RAG foreign keys were created with NO ACTION, so deleting a document version was
-- blocked by the index bookkeeping that references it. tests/http/workflow.test.ts fails
-- its cleanup with: update or delete on table "document_versions" violates foreign key
-- constraint "rag_export_queue_version_id_fkey".
--
-- Both tables hold derived data: the queue is work to do about a version, the entries are
-- a record of what was sent. Neither is a system of record, so when the version itself is
-- gone they should go with it rather than pin it in place.
--
-- Caveat, deliberately accepted: a cascade removes the knowledge_id before the exporter
-- could issue the matching delete to WeKnora, leaving a record there with no owner. That
-- is tolerable because approved versions are immutable and are never deleted in normal
-- operation -- only test cleanup and operator surgery reach this path. Recovery is
-- app.reconcile_rag_exports() plus a manual sweep; see docs/WEKNORA.md.
ALTER TABLE app.rag_export_queue DROP CONSTRAINT rag_export_queue_version_id_fkey;
ALTER TABLE app.rag_export_queue ADD CONSTRAINT rag_export_queue_version_id_fkey
 FOREIGN KEY (version_id) REFERENCES app.document_versions(id) ON DELETE CASCADE;
ALTER TABLE app.rag_index_entries DROP CONSTRAINT rag_index_entries_version_id_fkey;
ALTER TABLE app.rag_index_entries ADD CONSTRAINT rag_index_entries_version_id_fkey
 FOREIGN KEY (version_id) REFERENCES app.document_versions(id) ON DELETE CASCADE;
ALTER TABLE app.rag_index_entries DROP CONSTRAINT rag_index_entries_document_id_fkey;
ALTER TABLE app.rag_index_entries ADD CONSTRAINT rag_index_entries_document_id_fkey
 FOREIGN KEY (document_id) REFERENCES app.documents(id) ON DELETE CASCADE;
