-- Additive M2a migration. Never rewrite 001 or the user's CRLF-sensitive 002.
ALTER TABLE app.categories ADD COLUMN minimum_classification text NOT NULL DEFAULT 'internal'
 CHECK(minimum_classification IN ('public','internal','restricted','confidential'));
-- Tighten the existing synthetic Security category; fresh seed also sets this floor.
UPDATE app.categories SET minimum_classification='restricted'
 WHERE id='10000000-0000-4000-8000-000000000002';

CREATE TABLE app.upload_requests (
 owner_id text NOT NULL REFERENCES app.profiles(id), request_id uuid NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'), category_id uuid NOT NULL REFERENCES app.categories(id),
 state text NOT NULL CHECK(state IN ('processing','failed','complete')),
 lease_token uuid NOT NULL, lease_until timestamptz NOT NULL,
 document_id uuid NOT NULL, version_id uuid NOT NULL,
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
 error_code text CHECK(length(error_code)<=64),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,payload_hash)
);
CREATE INDEX upload_requests_owner_time_idx ON app.upload_requests(owner_id,created_at DESC);
CREATE TABLE app.version_sources (
 version_id uuid PRIMARY KEY REFERENCES app.document_versions(id),
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 180),
 original_key text NOT NULL UNIQUE, original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),
 original_bytes integer NOT NULL CHECK(original_bytes BETWEEN 1 AND 1048576),
 source_format text NOT NULL CHECK(source_format IN ('MD','TXT')),
 provenance_key text NOT NULL UNIQUE, provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
 metadata_snapshot jsonb NOT NULL CHECK(jsonb_typeof(metadata_snapshot)='object'),
 scanner_version text NOT NULL, signature_version bigint NOT NULL CHECK(signature_version>0),
 signature_date timestamptz NOT NULL, scanned_at timestamptz NOT NULL,
 scan_verdict text NOT NULL CHECK(scan_verdict='clean'),
 pipeline_revision text NOT NULL CHECK(pipeline_revision='text-v1'),
 processing_state text NOT NULL CHECK(processing_state='preview_ready')
);
CREATE FUNCTION app.can_upload_to(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 WITH RECURSIVE ancestors AS (
  SELECT id,parent_id,minimum_classification,ARRAY[id] AS visited FROM app.categories WHERE id=target
  UNION ALL
  SELECT c.id,c.parent_id,c.minimum_classification,a.visited||c.id FROM app.categories c JOIN ancestors a ON c.id=a.parent_id
  WHERE NOT(c.id=ANY(a.visited)) AND cardinality(a.visited)<10
 )
 SELECT app.actor_active() AND app.actor_role() IN ('super_admin','knowledge_admin','reviewer','contributor')
 AND app.in_category(target) AND EXISTS(SELECT 1 FROM ancestors WHERE id=target)
 AND NOT EXISTS(SELECT 1 FROM ancestors WHERE minimum_classification NOT IN ('public','internal')
 OR parent_id=ANY(visited) OR (cardinality(visited)>=10 AND parent_id IS NOT NULL))
$$;
GRANT CREATE ON SCHEMA app TO intradocs_policy;
ALTER FUNCTION app.can_upload_to(uuid) OWNER TO intradocs_policy;
REVOKE CREATE ON SCHEMA app FROM intradocs_policy;
REVOKE ALL ON FUNCTION app.can_upload_to(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_upload_to(uuid) TO intradocs_app,intradocs_policy;

-- A role downgrade to Viewer must not preserve access to unpublished drafts.
CREATE OR REPLACE FUNCTION app.private_document_access(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_role()<>'viewer' AND (
 EXISTS(SELECT 1 FROM app.documents WHERE id=target AND owner_id=app.actor_id())
 OR EXISTS(SELECT 1 FROM app.review_assignments WHERE document_id=target AND user_id=app.actor_id()))
$$;

ALTER TABLE app.upload_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.upload_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_requests_read ON app.upload_requests FOR SELECT TO intradocs_app
 USING(owner_id=app.actor_id() AND app.actor_active());
CREATE POLICY upload_requests_insert ON app.upload_requests FOR INSERT TO intradocs_app
 WITH CHECK(owner_id=app.actor_id() AND app.can_upload_to(category_id) AND state='processing' AND attempts=1);
CREATE POLICY upload_requests_update ON app.upload_requests FOR UPDATE TO intradocs_app
 USING(owner_id=app.actor_id() AND app.actor_active()) WITH CHECK(owner_id=app.actor_id() AND app.actor_active());
GRANT SELECT,INSERT ON app.upload_requests TO intradocs_app;
GRANT UPDATE(state,lease_token,lease_until,document_id,version_id,attempts,error_code,updated_at) ON app.upload_requests TO intradocs_app;

CREATE POLICY documents_insert_draft ON app.documents FOR INSERT TO intradocs_app WITH CHECK(
 owner_id=app.actor_id() AND app.can_upload_to(category_id) AND classification='internal'
 AND current_version_id IS NULL AND NOT withdrawn AND cardinality(labels)<=8
 AND length(title) BETWEEN 1 AND 180 AND length(summary)<=1000
);
CREATE POLICY versions_insert_draft ON app.document_versions FOR INSERT TO intradocs_app WITH CHECK(
 review_state='draft' AND label='0.1' AND approved_by IS NULL AND approved_by_label IS NULL
 AND approved_at IS NULL AND review_at IS NULL AND expires_at IS NULL AND source_format IN ('MD','TXT')
 AND byte_size BETWEEN 1 AND 2097152 AND EXISTS(SELECT 1 FROM app.documents d
 WHERE d.id=document_id AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id)
 AND d.current_version_id IS NULL AND markdown_key='documents/'||d.id||'/versions/'||app.document_versions.id||'/content.md')
);
GRANT INSERT ON app.documents,app.document_versions TO intradocs_app;
ALTER TABLE app.version_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.version_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY version_sources_read ON app.version_sources FOR SELECT TO intradocs_app USING(app.can_read_version(version_id));
CREATE POLICY version_sources_insert ON app.version_sources FOR INSERT TO intradocs_app WITH CHECK(
 signature_date>=now()-interval '7 days' AND signature_date<=now()+interval '1 day'
 AND scanned_at>=now()-interval '90 seconds' AND scanned_at<=now()+interval '1 minute'
 AND EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
 WHERE v.id=version_id AND v.review_state='draft' AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id)
 AND original_key='documents/'||d.id||'/versions/'||v.id||'/original.'||lower(app.version_sources.source_format)
 AND provenance_key='documents/'||d.id||'/versions/'||v.id||'/provenance.json'
 AND metadata_snapshot->>'title'=d.title AND metadata_snapshot->>'summary'=d.summary
 AND metadata_snapshot->>'categoryId'=d.category_id::text AND metadata_snapshot->>'classification'='internal'
 AND metadata_snapshot->'labels'=to_jsonb(d.labels) AND metadata_snapshot->>'synthetic'='true')
);
GRANT SELECT,INSERT ON app.version_sources TO intradocs_app;

-- All rows are committed together. No grant to UPDATE a document/version/source, approve,
-- change its owner/classification, assign reviewers, or set a publication pointer is added.
CREATE FUNCTION app.guard_created_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF app.actor_id() IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM app.upload_requests r JOIN app.document_versions v ON v.id=r.version_id
 JOIN app.version_sources s ON s.version_id=v.id
 WHERE r.owner_id=app.actor_id() AND r.document_id=NEW.id AND r.state='complete'
 AND v.document_id=NEW.id AND v.review_state='draft' AND s.scan_verdict='clean'
 ) THEN RAISE EXCEPTION 'Draft requires a completed upload and immutable source evidence'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.guard_created_draft() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER uploaded_draft_complete AFTER INSERT ON app.documents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_created_draft();

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected'
));
CREATE POLICY audit_upload_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND app.actor_role()<>'viewer' AND (
 (action='document.uploaded' AND document_id IS NOT NULL AND app.can_read_document(document_id))
 OR (action='upload.rejected' AND document_id IS NULL AND subject_user_id IS NULL))
);
