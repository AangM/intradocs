-- Completion hardening. Preserve checkpoint migrations 001–006 byte-for-byte.
CREATE TABLE app.version_attachments (
 version_id uuid NOT NULL REFERENCES app.document_versions(id), ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 4),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180), source_format text NOT NULL CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX')),
 original_key text NOT NULL UNIQUE, original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 original_bytes integer NOT NULL CHECK(original_bytes BETWEEN 1 AND 52428800), scan_evidence jsonb NOT NULL,
 PRIMARY KEY(version_id,ordinal),
 CHECK(scan_evidence->>'engine'='clamav' AND scan_evidence->>'verdict'='clean' AND scan_evidence->>'sha256'=original_sha256)
);
ALTER TABLE app.version_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.version_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_read ON app.version_attachments FOR SELECT TO intradocs_app USING(app.can_read_version(version_id));
CREATE POLICY attachments_insert ON app.version_attachments FOR INSERT TO intradocs_app WITH CHECK(
 app.actor_active() AND (scan_evidence->>'scannedAt')::timestamptz BETWEEN now()-interval '300 seconds' AND now()+interval '1 minute'
 AND (scan_evidence->>'signatureDate')::timestamptz BETWEEN now()-interval '7 days' AND now()+interval '1 day'
 AND EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id JOIN app.version_sources s ON s.version_id=v.id
 WHERE v.id=version_id AND d.owner_id=app.actor_id() AND v.review_state='draft' AND app.can_upload_to(v.category_id)
 AND original_key='documents/'||d.id||'/versions/'||v.id||'/attachment-'||ordinal||'.'||lower(app.version_attachments.source_format)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.metadata_snapshot->'attachments','[]')) a
 WHERE (a->>'ordinal')::integer=ordinal AND a->>'sha256'=original_sha256 AND a->>'key'=original_key AND a->>'name'=name))) ;
GRANT SELECT,INSERT ON app.version_attachments TO intradocs_app;
GRANT SELECT ON app.version_attachments TO intradocs_workflow,intradocs_policy;
CREATE FUNCTION app.check_attachment_manifest() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE expected integer; BEGIN
 expected:=coalesce(jsonb_array_length(NEW.metadata_snapshot->'attachments'),0);
 IF expected>4 OR expected<>(SELECT count(*) FROM app.version_attachments WHERE version_id=NEW.version_id) THEN
  RAISE EXCEPTION 'Incomplete attachment manifest' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attachment_manifest_complete AFTER INSERT ON app.version_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_attachment_manifest();
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.check_attachment_manifest() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.check_attachment_manifest() FROM PUBLIC;

-- M2 multi-file work gets a bounded 300-second admission/scan window.
DROP POLICY version_sources_insert ON app.version_sources;
CREATE POLICY version_sources_insert ON app.version_sources FOR INSERT TO intradocs_app WITH CHECK(
 signature_date BETWEEN now()-interval '7 days' AND now()+interval '1 day'
 AND scanned_at BETWEEN now()-interval '300 seconds' AND now()+interval '1 minute'
 AND EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
 WHERE v.id=version_id AND v.review_state='draft' AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id)
 AND original_key='documents/'||d.id||'/versions/'||v.id||'/original.'||lower(app.version_sources.source_format)
 AND provenance_key='documents/'||d.id||'/versions/'||v.id||'/provenance.json'
 AND metadata_snapshot->>'title'=v.title AND metadata_snapshot->>'summary'=v.summary
 AND metadata_snapshot->>'categoryId'=v.category_id::text AND metadata_snapshot->>'classification'=v.classification
 AND metadata_snapshot->'labels'=to_jsonb(v.labels) AND metadata_snapshot->>'synthetic'='true')
);

-- Counts only for currently visible active documents, not a global analytics bypass.
GRANT SELECT ON app.audit_events TO intradocs_workflow;
CREATE FUNCTION app.most_read_documents() RETURNS TABLE(id uuid,slug text,title text,reads integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.slug,v.title,count(a.id)::integer
 FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id
 JOIN app.audit_events a ON a.document_id=d.id AND a.action='document.read' AND a.created_at>=now()-interval '30 days'
 WHERE app.is_active_version(v.id) GROUP BY d.id,d.slug,v.title ORDER BY count(a.id) DESC,d.id LIMIT 5
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.most_read_documents() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.most_read_documents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.most_read_documents() TO intradocs_app;

-- Direct RLS-guarded writes must not edit another person's opinion, even an owner.
REVOKE UPDATE ON app.document_feedback FROM intradocs_app;
GRANT UPDATE(helpful,comment,created_at) ON app.document_feedback TO intradocs_app;
CREATE INDEX approval_steps_reviewer_idx ON app.approval_steps(reviewer_id,request_id);
CREATE INDEX audit_document_action_idx ON app.audit_events(document_id,action,created_at DESC);
CREATE INDEX documents_search_title_idx ON app.document_versions(lower(title));
