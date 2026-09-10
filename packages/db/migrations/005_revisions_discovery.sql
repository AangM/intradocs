-- Immutable revisions re-use the scanned upload admission/receipt; never replace existing objects.
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_source_format_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_source_format_check CHECK(source_format IN ('MD','TXT','PDF','DOCX','XLSX'));
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_original_bytes_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_original_bytes_check CHECK(original_bytes BETWEEN 1 AND 52428800);
ALTER TABLE app.version_sources DROP CONSTRAINT version_sources_pipeline_revision_check;
ALTER TABLE app.version_sources ADD CONSTRAINT version_sources_pipeline_revision_check CHECK(pipeline_revision IN ('text-v1','canonical-v2'));
DROP POLICY versions_insert_draft ON app.document_versions;
CREATE POLICY versions_insert_draft ON app.document_versions FOR INSERT TO intradocs_app WITH CHECK(review_state='draft' AND label='0.1' AND version_number=1 AND approved_by IS NULL AND approved_by_label IS NULL AND approved_at IS NULL AND review_at IS NULL AND expires_at IS NULL AND processing_state='preview_ready' AND publication_state='unpublished'
 AND source_format IN ('MD','TXT','PDF','DOCX','XLSX') AND byte_size BETWEEN 1 AND 2097152 AND EXISTS(SELECT 1 FROM app.documents d WHERE d.id=document_id AND d.owner_id=app.actor_id() AND app.can_upload_to(d.category_id) AND d.current_version_id IS NULL AND markdown_key='documents/'||d.id||'/versions/'||app.document_versions.id||'/content.md'));
CREATE OR REPLACE FUNCTION app.can_upload_to(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND app.actor_role() IN ('super_admin','knowledge_admin','reviewer','contributor') AND app.in_category(target) AND EXISTS(SELECT 1 FROM app.categories WHERE id=target) AND NOT EXISTS(SELECT 1 FROM app.categories WHERE parent_id=target) AND app.classification_rank(app.category_floor(target))<=2 $$;
CREATE FUNCTION app.commit_revision(base uuid,new_version uuid,request_key uuid,lease uuid,metadata jsonb,artifact jsonb,evidence jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; d app.documents; prefix text; n integer; r app.upload_requests; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 IF NOT pg_try_advisory_xact_lock_shared(719283,1) THEN RAISE EXCEPTION 'Storage maintenance' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM app.document_versions WHERE id=base; SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_version(base) OR NOT app.can_upload_to(d.category_id) OR d.withdrawn THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF base<>(SELECT id FROM app.document_versions WHERE document_id=d.id ORDER BY version_number DESC LIMIT 1) THEN RAISE EXCEPTION 'Revision conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO r FROM app.upload_requests WHERE owner_id=app.actor_id() AND request_id=request_key AND state='processing' AND lease_token=lease AND lease_until>now() FOR UPDATE;
 IF r.request_id IS NULL OR r.document_id<>d.id OR r.version_id<>new_version THEN RAISE EXCEPTION 'Upload lease invalid' USING ERRCODE='40001'; END IF;
 IF metadata->>'categoryId' IS DISTINCT FROM d.category_id::text OR metadata->>'classification' IS DISTINCT FROM d.classification OR metadata->>'synthetic' IS DISTINCT FROM 'true' OR d.classification<>'internal' OR length(metadata->>'title') NOT BETWEEN 3 AND 180 OR length(metadata->>'summary')>1000 OR jsonb_typeof(metadata->'labels')<>'array' OR jsonb_array_length(metadata->'labels')>8 THEN RAISE EXCEPTION 'Revision metadata invalid' USING ERRCODE='23514'; END IF;
 IF evidence->>'verdict' IS DISTINCT FROM 'clean' OR evidence->>'engine' IS DISTINCT FROM 'clamav' OR evidence->>'sha256' IS DISTINCT FROM artifact->>'originalHash' OR (evidence->>'scannedAt')::timestamptz<now()-interval '90 seconds' OR (evidence->>'scannedAt')::timestamptz>now()+interval '1 minute' OR (evidence->>'signatureDate')::timestamptz<now()-interval '7 days' OR (evidence->>'signatureDate')::timestamptz>now()+interval '1 day' THEN RAISE EXCEPTION 'Scan evidence invalid' USING ERRCODE='23514'; END IF;
 prefix:='documents/'||d.id||'/versions/'||new_version;
 IF artifact->>'markdownKey' IS DISTINCT FROM prefix||'/content.md' OR artifact->>'originalKey' IS DISTINCT FROM prefix||'/original.'||lower(artifact->>'format') OR artifact->>'provenanceKey' IS DISTINCT FROM prefix||'/provenance.json' THEN RAISE EXCEPTION 'Invalid keys' USING ERRCODE='23514'; END IF;
 n:=v.version_number+1;
 INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,byte_size,source_format,title,summary,category_id,classification,labels,author_id,version_number,supersedes_id)
 VALUES(new_version,d.id,'0.'||n,'draft',artifact->>'markdownKey',artifact->>'markdownHash',(artifact->>'markdownBytes')::integer,artifact->>'format',metadata->>'title',metadata->>'summary',d.category_id,d.classification,ARRAY(SELECT jsonb_array_elements_text(metadata->'labels')),app.actor_id(),n,base);
 INSERT INTO app.version_sources(version_id,original_name,original_key,original_sha256,original_bytes,source_format,provenance_key,provenance_sha256,metadata_snapshot,scanner_version,signature_version,signature_date,scanned_at,scan_verdict,pipeline_revision,processing_state)
 VALUES(new_version,artifact->>'name',artifact->>'originalKey',artifact->>'originalHash',(artifact->>'originalBytes')::integer,artifact->>'format',artifact->>'provenanceKey',artifact->>'provenanceHash',metadata,evidence->>'version',(evidence->>'signatureVersion')::bigint,(evidence->>'signatureDate')::timestamptz,(evidence->>'scannedAt')::timestamptz,'clean',artifact->>'pipeline','preview_ready');
 UPDATE app.approval_requests SET state='cancelled',decided_at=now() WHERE version_id=base AND (state='pending' OR (state='approved' AND base IS DISTINCT FROM d.current_version_id));
 UPDATE app.publication_outbox SET state='cancelled',error_code='new_revision' WHERE version_id=base AND state IN ('pending','running','dead') AND base IS DISTINCT FROM d.current_version_id;
 UPDATE app.upload_requests SET state='complete',updated_at=now(),error_code=NULL WHERE owner_id=app.actor_id() AND request_id=request_key;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.revised',d.id,request_key); RETURN d.slug; END $$;
GRANT SELECT,UPDATE ON app.upload_requests TO intradocs_workflow;
GRANT INSERT ON app.version_sources TO intradocs_workflow;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.commit_revision(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.commit_revision(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_revision(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) TO intradocs_app;
CREATE TABLE app.favorites(user_id text NOT NULL REFERENCES app.profiles(id),document_id uuid NOT NULL REFERENCES app.documents(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,document_id));
CREATE TABLE app.read_history(user_id text NOT NULL REFERENCES app.profiles(id),version_id uuid NOT NULL REFERENCES app.document_versions(id),last_read_at timestamptz NOT NULL DEFAULT now(),reads integer NOT NULL DEFAULT 1 CHECK(reads>0),PRIMARY KEY(user_id,version_id));
CREATE TABLE app.document_feedback(id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),user_id text NOT NULL REFERENCES app.profiles(id),version_id uuid NOT NULL REFERENCES app.document_versions(id),helpful boolean NOT NULL,comment text NOT NULL DEFAULT '' CHECK(length(comment)<=2000),created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,UNIQUE(user_id,version_id));
CREATE TABLE app.notifications(id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),user_id text NOT NULL REFERENCES app.profiles(id),version_id uuid NOT NULL REFERENCES app.document_versions(id),kind text NOT NULL CHECK(kind IN ('review_assigned','review_decided','published','review_due','expired','feedback','index_failed')),event_key text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,event_key));
CREATE TABLE app.search_events(id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),actor_id text NOT NULL REFERENCES app.profiles(id),result_count integer NOT NULL CHECK(result_count>=0),duration_ms integer NOT NULL CHECK(duration_ms>=0),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX history_recent_idx ON app.read_history(user_id,last_read_at DESC);
CREATE INDEX notifications_unread_idx ON app.notifications(user_id,created_at DESC) WHERE read_at IS NULL;
CREATE INDEX search_events_time_idx ON app.search_events(created_at);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['favorites','read_history','document_feedback','notifications','search_events'] LOOP EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t); END LOOP; END $$;
CREATE POLICY favorites_read ON app.favorites FOR SELECT TO intradocs_app USING(user_id=app.actor_id() AND EXISTS(SELECT 1 FROM app.documents d WHERE d.id=document_id AND app.is_active_version(d.current_version_id)));
CREATE POLICY favorites_add ON app.favorites FOR INSERT TO intradocs_app WITH CHECK(user_id=app.actor_id() AND EXISTS(SELECT 1 FROM app.documents d WHERE d.id=document_id AND app.is_active_version(d.current_version_id)));
CREATE POLICY favorites_remove ON app.favorites FOR DELETE TO intradocs_app USING(user_id=app.actor_id() AND app.actor_active());
CREATE POLICY history_read ON app.read_history FOR SELECT TO intradocs_app USING(user_id=app.actor_id() AND app.can_read_version(version_id));
CREATE POLICY history_add ON app.read_history FOR INSERT TO intradocs_app WITH CHECK(user_id=app.actor_id() AND app.can_read_version(version_id));
CREATE POLICY history_update ON app.read_history FOR UPDATE TO intradocs_app USING(user_id=app.actor_id() AND app.can_read_version(version_id)) WITH CHECK(user_id=app.actor_id() AND app.can_read_version(version_id));
CREATE POLICY feedback_read ON app.document_feedback FOR SELECT TO intradocs_app USING(app.can_read_version(version_id) AND (user_id=app.actor_id() OR EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=version_id AND d.owner_id=app.actor_id())));
CREATE POLICY feedback_add ON app.document_feedback FOR INSERT TO intradocs_app WITH CHECK(user_id=app.actor_id() AND app.is_active_version(version_id));
CREATE POLICY feedback_update ON app.document_feedback FOR UPDATE TO intradocs_app USING(user_id=app.actor_id() AND app.is_active_version(version_id)) WITH CHECK(user_id=app.actor_id() AND app.is_active_version(version_id));
CREATE POLICY notifications_read ON app.notifications FOR SELECT TO intradocs_app USING(user_id=app.actor_id() AND app.can_read_version(version_id));
CREATE POLICY notifications_update ON app.notifications FOR UPDATE TO intradocs_app USING(user_id=app.actor_id() AND app.can_read_version(version_id)) WITH CHECK(user_id=app.actor_id() AND app.can_read_version(version_id));
CREATE POLICY search_events_read ON app.search_events FOR SELECT TO intradocs_app USING(app.actor_active() AND (actor_id=app.actor_id() OR (app.actor_role() IN ('super_admin','knowledge_admin') AND app.can_view_profile(actor_id))));
CREATE POLICY search_events_add ON app.search_events FOR INSERT TO intradocs_app WITH CHECK(actor_id=app.actor_id() AND app.actor_active());
GRANT SELECT,INSERT,DELETE ON app.favorites TO intradocs_app;
GRANT SELECT,INSERT ON app.read_history,app.document_feedback,app.search_events TO intradocs_app;
GRANT UPDATE(last_read_at,reads) ON app.read_history TO intradocs_app;
GRANT UPDATE(helpful,comment,created_at) ON app.document_feedback TO intradocs_app;
GRANT SELECT ON app.notifications TO intradocs_app;
GRANT UPDATE(read_at) ON app.notifications TO intradocs_app;
GRANT SELECT,INSERT,UPDATE ON app.notifications TO intradocs_workflow;
GRANT SELECT ON app.document_feedback TO intradocs_workflow;
CREATE FUNCTION app.notify_workflow() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE vid uuid; owner text; BEGIN
 IF TG_TABLE_NAME='approval_steps' THEN SELECT r.version_id,v.author_id INTO vid,owner FROM app.approval_requests r JOIN app.document_versions v ON v.id=r.version_id WHERE r.id=NEW.request_id;
 IF TG_OP='INSERT' THEN INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(NEW.reviewer_id,vid,'review_assigned','assigned:'||NEW.request_id||':'||NEW.stage) ON CONFLICT DO NOTHING;
 ELSIF NEW.decision IS NOT NULL AND OLD.decision IS NULL THEN INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,vid,'review_decided','decision:'||NEW.request_id||':'||NEW.stage) ON CONFLICT DO NOTHING; END IF;
 ELSIF TG_TABLE_NAME='publication_outbox' THEN IF NEW.state IN ('done','dead') AND OLD.state IS DISTINCT FROM NEW.state THEN SELECT author_id INTO owner FROM app.document_versions WHERE id=NEW.version_id;
 INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,NEW.version_id,CASE WHEN NEW.state='done' THEN 'published' ELSE 'index_failed' END,NEW.state||':'||NEW.id) ON CONFLICT DO NOTHING; END IF;
 ELSIF TG_TABLE_NAME='document_feedback' THEN SELECT d.owner_id INTO owner FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=NEW.version_id;
 INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,NEW.version_id,'feedback','feedback:'||NEW.id) ON CONFLICT DO NOTHING; END IF; RETURN NEW; END $$;
CREATE TRIGGER notify_step AFTER INSERT OR UPDATE ON app.approval_steps FOR EACH ROW EXECUTE FUNCTION app.notify_workflow();
CREATE TRIGGER notify_publication AFTER UPDATE ON app.publication_outbox FOR EACH ROW EXECUTE FUNCTION app.notify_workflow();
CREATE TRIGGER notify_feedback AFTER INSERT OR UPDATE ON app.document_feedback FOR EACH ROW EXECUTE FUNCTION app.notify_workflow();
CREATE FUNCTION app.enqueue_review_reminders() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE n integer; BEGIN
 INSERT INTO app.notifications(user_id,version_id,kind,event_key) SELECT d.owner_id,v.id,CASE WHEN v.expires_at<=now() THEN 'expired' ELSE 'review_due' END,CASE WHEN v.expires_at<=now() THEN 'expiry:'||v.id ELSE 'review:'||v.id||':'||v.review_at::text END
 FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE NOT d.withdrawn AND (v.review_at<=now()+interval '14 days' OR v.expires_at<=now()) AND v.review_state='approved' ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.notify_workflow() OWNER TO intradocs_workflow;
ALTER FUNCTION app.enqueue_review_reminders() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.notify_workflow(),app.enqueue_review_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_review_reminders() TO intradocs_worker;
CREATE FUNCTION app.bootstrap_seed_index() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF app.actor_id() IS NULL AND NEW.review_state='approved' THEN INSERT INTO app.publication_outbox(version_id) VALUES(NEW.id) ON CONFLICT DO NOTHING; END IF; RETURN NEW; END $$;
CREATE TRIGGER seed_lexical_outbox AFTER INSERT ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.bootstrap_seed_index();
REVOKE ALL ON FUNCTION app.bootstrap_seed_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bootstrap_seed_index() TO intradocs_app,intradocs_workflow;
