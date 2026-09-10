-- Additive completion of classification/grants; all corpus remains synthetic/local.
CREATE OR REPLACE FUNCTION app.can_upload_to(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND app.actor_role() IN ('super_admin','knowledge_admin','reviewer','contributor') AND app.in_category(target)
 AND EXISTS(SELECT 1 FROM app.categories WHERE id=target) AND NOT EXISTS(SELECT 1 FROM app.categories WHERE parent_id=target)
$$;
DROP POLICY documents_insert_draft ON app.documents;
CREATE POLICY documents_insert_draft ON app.documents FOR INSERT TO intradocs_app WITH CHECK(
 owner_id=app.actor_id() AND app.can_upload_to(category_id) AND app.classification_rank(classification)>=app.classification_rank(app.category_floor(category_id))
 AND current_version_id IS NULL AND NOT withdrawn AND cardinality(labels)<=8 AND length(title) BETWEEN 3 AND 180 AND length(summary)<=1000
);
GRANT SELECT,INSERT,DELETE ON app.document_grants TO intradocs_workflow;
CREATE FUNCTION app.grant_source_author() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF app.actor_id() IS NOT NULL AND NEW.owner_id=app.actor_id() AND app.can_upload_to(NEW.category_id)
 AND app.classification_rank(NEW.classification)>2 THEN
 INSERT INTO app.document_grants(document_id,user_id) VALUES(NEW.id,NEW.owner_id) ON CONFLICT DO NOTHING;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER source_author_grant AFTER INSERT ON app.documents FOR EACH ROW EXECUTE FUNCTION app.grant_source_author();
CREATE FUNCTION app.document_access_candidates(target uuid) RETURNS TABLE(id text,name text,role text,granted boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE d app.documents; BEGIN
 SELECT * INTO d FROM app.documents WHERE app.documents.id=target;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_document(target) OR app.actor_role()='viewer' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 RETURN QUERY SELECT p.id,p.name,p.role,EXISTS(SELECT 1 FROM app.document_grants g WHERE g.document_id=target AND g.user_id=p.id)
 FROM app.profiles p WHERE p.active AND p.id<>d.owner_id AND p.role IN ('super_admin','knowledge_admin','reviewer','contributor') AND app.member_in_category(p.id,d.category_id) ORDER BY p.name LIMIT 100;
 END $$;
CREATE FUNCTION app.set_document_access(target uuid,member text,allow_access boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE d app.documents; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO d FROM app.documents WHERE id=target FOR UPDATE;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_document(target) OR app.actor_role()='viewer' OR member=app.actor_id() OR allow_access IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF allow_access THEN
 IF NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=member AND active AND role<>'viewer') OR NOT app.member_in_category(member,d.category_id) THEN RAISE EXCEPTION 'Member outside allowed scope' USING ERRCODE='42501'; END IF;
 INSERT INTO app.document_grants(document_id,user_id) VALUES(target,member) ON CONFLICT DO NOTHING;
 ELSE DELETE FROM app.document_grants WHERE document_id=target AND user_id=member; END IF;
 INSERT INTO app.audit_events(actor_id,action,document_id,subject_user_id,request_id) VALUES(app.actor_id(),'document.access_changed',target,member,public.gen_random_uuid());
 END $$;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN ('document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed'));
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.grant_source_author() OWNER TO intradocs_workflow;
ALTER FUNCTION app.document_access_candidates(uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.set_document_access(uuid,text,boolean) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.grant_source_author(),app.document_access_candidates(uuid),app.set_document_access(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.category_floor(uuid),app.document_access_candidates(uuid),app.set_document_access(uuid,text,boolean) TO intradocs_app;
DROP POLICY attachments_insert ON app.version_attachments;
CREATE POLICY attachments_insert ON app.version_attachments FOR INSERT TO intradocs_app WITH CHECK(
 app.actor_active() AND (scan_evidence->>'scannedAt')::timestamptz BETWEEN now()-interval '300 seconds' AND now()+interval '1 minute'
 AND (scan_evidence->>'signatureDate')::timestamptz BETWEEN now()-interval '7 days' AND now()+interval '1 day'
 AND EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id JOIN app.version_sources s ON s.version_id=v.id
 WHERE v.id=app.version_attachments.version_id AND d.owner_id=app.actor_id() AND v.review_state='draft' AND app.can_upload_to(v.category_id)
 AND app.version_attachments.original_key='documents/'||d.id||'/versions/'||v.id||'/attachment-'||app.version_attachments.ordinal||'.'||lower(app.version_attachments.source_format)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.metadata_snapshot->'attachments','[]')) a
 WHERE (a->>'ordinal')::integer=app.version_attachments.ordinal AND a->>'sha256'=app.version_attachments.original_sha256 AND a->>'key'=app.version_attachments.original_key AND a->>'name'=app.version_attachments.name))) ;
CREATE OR REPLACE FUNCTION app.commit_revision(base uuid,new_version uuid,request_key uuid,lease uuid,metadata jsonb,artifact jsonb,evidence jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; d app.documents; prefix text; n integer; r app.upload_requests; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 IF NOT pg_try_advisory_xact_lock_shared(719283,1) THEN RAISE EXCEPTION 'Storage maintenance' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM app.document_versions WHERE id=base; SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_version(base) OR NOT app.can_upload_to(d.category_id) OR d.withdrawn THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF base<>(SELECT id FROM app.document_versions WHERE document_id=d.id ORDER BY version_number DESC LIMIT 1) THEN RAISE EXCEPTION 'Revision conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO r FROM app.upload_requests WHERE owner_id=app.actor_id() AND request_id=request_key AND state='processing' AND lease_token=lease AND lease_until>now() FOR UPDATE;
 IF r.request_id IS NULL OR r.document_id<>d.id OR r.version_id<>new_version THEN RAISE EXCEPTION 'Upload lease invalid' USING ERRCODE='40001'; END IF;
 IF metadata->>'categoryId' IS DISTINCT FROM d.category_id::text OR metadata->>'classification' IS DISTINCT FROM d.classification OR metadata->>'synthetic' IS DISTINCT FROM 'true' OR length(metadata->>'title') NOT BETWEEN 3 AND 180 OR length(metadata->>'summary')>1000 OR jsonb_typeof(metadata->'labels')<>'array' OR jsonb_array_length(metadata->'labels')>8 THEN RAISE EXCEPTION 'Revision metadata invalid' USING ERRCODE='23514'; END IF;
 IF evidence->>'verdict' IS DISTINCT FROM 'clean' OR evidence->>'engine' IS DISTINCT FROM 'clamav' OR evidence->>'sha256' IS DISTINCT FROM artifact->>'originalHash' OR (evidence->>'scannedAt')::timestamptz<now()-interval '300 seconds' OR (evidence->>'scannedAt')::timestamptz>now()+interval '1 minute' OR (evidence->>'signatureDate')::timestamptz<now()-interval '7 days' OR (evidence->>'signatureDate')::timestamptz>now()+interval '1 day' THEN RAISE EXCEPTION 'Scan evidence invalid' USING ERRCODE='23514'; END IF;
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
CREATE OR REPLACE FUNCTION app.publish_lexical(job uuid,token uuid,chunks jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.publication_outbox; v app.document_versions; d app.documents; r app.approval_requests; full_text text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT * INTO j FROM app.publication_outbox WHERE id=job;
 IF j.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v FROM app.document_versions WHERE id=j.version_id; SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE;
 SELECT * INTO v FROM app.document_versions WHERE id=j.version_id; SELECT * INTO j FROM app.publication_outbox WHERE id=job FOR UPDATE;
 IF j.state='done' THEN RETURN; END IF;
 IF j.state<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=now() THEN RAISE EXCEPTION 'Stale lease' USING ERRCODE='40001'; END IF;
 SELECT * INTO r FROM app.approval_requests WHERE version_id=v.id;
 IF d.withdrawn OR (r.id IS NOT NULL AND (NOT app.member_can_classification(v.author_id,d.id,v.category_id,v.classification) OR NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=v.author_id AND active AND role<>'viewer'))) OR v.review_state<>'approved' OR (v.expires_at IS NOT NULL AND v.expires_at<=now()) OR (r.id IS NOT NULL AND (r.state<>'approved' OR r.revision_hash<>v.markdown_sha256 OR (SELECT count(*) FROM app.approval_steps WHERE request_id=r.id AND decision='approve')<>r.required_steps OR EXISTS(SELECT 1 FROM app.approval_steps s WHERE s.request_id=r.id AND NOT app.reviewer_eligible(s.reviewer_id,v.id)) OR app.rule_steps(v.id)>r.required_steps)) OR EXISTS(SELECT 1 FROM app.document_versions n WHERE n.document_id=d.id AND n.version_number>v.version_number AND n.review_state IN ('in_review','approved')) THEN
 UPDATE app.publication_outbox SET state='cancelled',error_code='stale_approval' WHERE id=job; UPDATE app.document_versions SET processing_state='failed' WHERE id=v.id AND publication_state='unpublished'; RETURN; END IF;
 IF chunks IS NULL OR jsonb_typeof(chunks)<>'array' OR jsonb_array_length(chunks) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid chunks' USING ERRCODE='23514'; END IF;
 SELECT string_agg(c.value->>'text','' ORDER BY c.ordinality) INTO full_text FROM jsonb_array_elements(chunks) WITH ORDINALITY c;
 IF full_text IS NULL OR octet_length(full_text)>2097152 OR encode(public.digest(full_text,'sha256'),'hex')<>v.markdown_sha256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(chunks) WITH ORDINALITY c WHERE (c.value->>'ordinal')::integer IS DISTINCT FROM c.ordinality-1 OR c.value->>'text' IS NULL OR length(c.value->>'text') NOT BETWEEN 1 AND 16000 OR c.value->>'lineStart' IS NULL OR (c.value->>'lineStart')::integer<1 OR c.value->>'lineEnd' IS NULL OR (c.value->>'lineEnd')::integer<(c.value->>'lineStart')::integer) THEN RAISE EXCEPTION 'Index content mismatch' USING ERRCODE='23514'; END IF;
 DELETE FROM app.lexical_chunks WHERE version_id=v.id;
 INSERT INTO app.lexical_chunks(version_id,ordinal,content,line_start,line_end) SELECT v.id,(c->>'ordinal')::integer,c->>'text',(c->>'lineStart')::integer,(c->>'lineEnd')::integer FROM jsonb_array_elements(chunks) c;
 INSERT INTO app.index_generations(version_id,pipeline,source_hash,chunk_count) VALUES(v.id,'lexical-v1',v.markdown_sha256,jsonb_array_length(chunks)) ON CONFLICT(version_id) DO UPDATE SET source_hash=excluded.source_hash,chunk_count=excluded.chunk_count,ready_at=now();
 UPDATE app.document_versions SET publication_state='superseded' WHERE id=d.current_version_id AND id<>v.id;
 UPDATE app.document_versions SET processing_state='ready',publication_state='published' WHERE id=v.id;
 UPDATE app.documents SET current_version_id=v.id,title=v.title,summary=v.summary,category_id=v.category_id,classification=v.classification,labels=v.labels WHERE id=d.id;
 UPDATE app.publication_outbox SET state='done',lease_until=NULL,error_code=NULL WHERE id=job;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(coalesce(v.approved_by,v.author_id),'document.published',d.id,job); END $$;
