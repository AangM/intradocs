-- S05 V1: HTML through the local converter (text and block structure only; scripts,
-- styles, links and embedded objects are dropped before anything is stored). The original
-- .html file is downloaded as text/plain so a browser never renders it.
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_source_format_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_source_format_check
 CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX','HTML','PPTX'));
ALTER TABLE app.version_attachments DROP CONSTRAINT version_attachments_source_format_check;
ALTER TABLE app.version_attachments ADD CONSTRAINT version_attachments_source_format_check
 CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX','HTML','PPTX'));
DROP POLICY versions_insert_draft ON app.document_versions;
CREATE POLICY versions_insert_draft ON app.document_versions FOR INSERT TO intradocs_app WITH CHECK(review_state='draft' AND label='0.1' AND version_number=1 AND approved_by IS NULL AND approved_by_label IS NULL AND approved_at IS NULL AND review_at IS NULL AND expires_at IS NULL AND processing_state='preview_ready' AND publication_state='unpublished'
 AND source_format IN ('MD','TXT','PDF','DOCX','XLSX','HTML','PPTX') AND byte_size BETWEEN 1 AND 2097152 AND EXISTS(SELECT 1 FROM app.documents d WHERE d.id=document_id AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id) AND d.current_version_id IS NULL AND markdown_key='documents/'||d.id||'/versions/'||app.document_versions.id||'/content.md'));
