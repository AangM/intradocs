-- S05 V1 (partial): PPTX arrives through WeKnora's in-process parser (weknora-parse.ts).
-- The original .pptx is stored like any other source; the canonical Markdown it yields
-- is labelled with its own pipeline revision so provenance says who produced it.
-- Scanned PDF/OCR is NOT part of this: it needs WeKnora's docreader (~4 GB), which
-- does not fit beside WeKnora on the reference machine (docs/WEKNORA.md §27).
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_source_format_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_source_format_check
 CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX','PPTX'));
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_pipeline_revision_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_pipeline_revision_check
 CHECK(pipeline_revision IN ('text-v1','canonical-v2','weknora-parse-v1'));
-- The draft-insert policy and the attachment table list the formats too.
ALTER TABLE app.version_attachments DROP CONSTRAINT version_attachments_source_format_check;
ALTER TABLE app.version_attachments ADD CONSTRAINT version_attachments_source_format_check
 CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX','PPTX'));
DROP POLICY versions_insert_draft ON app.document_versions;
CREATE POLICY versions_insert_draft ON app.document_versions FOR INSERT TO intradocs_app WITH CHECK(review_state='draft' AND label='0.1' AND version_number=1 AND approved_by IS NULL AND approved_by_label IS NULL AND approved_at IS NULL AND review_at IS NULL AND expires_at IS NULL AND processing_state='preview_ready' AND publication_state='unpublished'
 AND source_format IN ('MD','TXT','PDF','DOCX','XLSX','PPTX') AND byte_size BETWEEN 1 AND 2097152 AND EXISTS(SELECT 1 FROM app.documents d WHERE d.id=document_id AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id) AND d.current_version_id IS NULL AND markdown_key='documents/'||d.id||'/versions/'||app.document_versions.id||'/content.md'));
