-- Version labels follow the document, not the row count. A revision of "1.0" is "1.1"
-- and a revision of "3.2" is "3.3"; a document that started at "0.1" keeps counting
-- 0.2, 0.3 as before. Until now every revision was labelled '0.'||version_number, which
-- turned the seeded "1.0" guide into "0.2" on its first revision -- the reader then
-- showed 0.2 as current and 1.0 as older. Who may revise, and everything else the two
-- functions check, is unchanged.
CREATE FUNCTION app.next_label(previous text, n integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN previous ~ '^[0-9]+\.[0-9]+$'
  THEN split_part(previous,'.',1)||'.'||(split_part(previous,'.',2)::integer+1)
  ELSE '0.'||n END
$$;
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
 VALUES(new_version,d.id,app.next_label(v.label,n),'draft',artifact->>'markdownKey',artifact->>'markdownHash',(artifact->>'markdownBytes')::integer,artifact->>'format',metadata->>'title',metadata->>'summary',d.category_id,d.classification,ARRAY(SELECT jsonb_array_elements_text(metadata->'labels')),app.actor_id(),n,base);
 INSERT INTO app.version_sources(version_id,original_name,original_key,original_sha256,original_bytes,source_format,provenance_key,provenance_sha256,metadata_snapshot,scanner_version,signature_version,signature_date,scanned_at,scan_verdict,pipeline_revision,processing_state)
 VALUES(new_version,artifact->>'name',artifact->>'originalKey',artifact->>'originalHash',(artifact->>'originalBytes')::integer,artifact->>'format',artifact->>'provenanceKey',artifact->>'provenanceHash',metadata,evidence->>'version',(evidence->>'signatureVersion')::bigint,(evidence->>'signatureDate')::timestamptz,(evidence->>'scannedAt')::timestamptz,'clean',artifact->>'pipeline','preview_ready');
 UPDATE app.approval_requests SET state='cancelled',decided_at=now() WHERE version_id=base AND (state='pending' OR (state='approved' AND base IS DISTINCT FROM d.current_version_id));
 UPDATE app.publication_outbox SET state='cancelled',error_code='new_revision' WHERE version_id=base AND state IN ('pending','running','dead') AND base IS DISTINCT FROM d.current_version_id;
 UPDATE app.upload_requests SET state='complete',updated_at=now(),error_code=NULL WHERE owner_id=app.actor_id() AND request_id=request_key;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.revised',d.id,request_key); RETURN d.slug; END $$;
CREATE OR REPLACE FUNCTION app.rollback_version(
 source uuid, new_version uuid, doc uuid, request_key uuid,
 md_key text, orig_key text, prov_key text)
RETURNS TABLE(version_id uuid, label text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; s app.version_sources; d app.documents; latest app.document_versions; n integer; prefix text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 SELECT * INTO v FROM app.document_versions WHERE id=source;
 IF v.id IS NULL OR v.document_id<>doc THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO d FROM app.documents WHERE id=doc FOR UPDATE;
 -- Same authority as creating a revision: owner, inside scope, document not withdrawn.
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_version(source)
  OR NOT app.can_upload_to(d.category_id) OR d.withdrawn THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 -- Only a version that once passed review may be restored. Restoring a draft or a
 -- rejected version would launder unreviewed text into a new draft.
 IF v.review_state<>'approved' THEN
  RAISE EXCEPTION 'Only an approved version can be restored' USING ERRCODE='23514'; END IF;
 SELECT * INTO latest FROM app.document_versions WHERE document_id=doc ORDER BY version_number DESC LIMIT 1;
 IF latest.id=source THEN RAISE EXCEPTION 'That version is already the latest' USING ERRCODE='23514'; END IF;
 -- One open draft at a time, matching the revision rules.
 IF latest.review_state IN ('draft','in_review') THEN
  RAISE EXCEPTION 'Finish the open draft first' USING ERRCODE='40001'; END IF;
 SELECT * INTO s FROM app.version_sources WHERE version_sources.version_id=source;
 IF s.version_id IS NULL THEN
  RAISE EXCEPTION 'Source version has no stored artifact' USING ERRCODE='P0002'; END IF;
 n:=latest.version_number+1;
 prefix:='documents/'||doc||'/versions/'||new_version;
 IF md_key IS DISTINCT FROM prefix||'/content.md'
  OR orig_key IS DISTINCT FROM prefix||'/original.'||lower(s.source_format)
  OR prov_key IS DISTINCT FROM prefix||'/provenance.json' THEN
  RAISE EXCEPTION 'Invalid keys' USING ERRCODE='23514'; END IF;
 INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,
  byte_size,source_format,title,summary,category_id,classification,labels,author_id,version_number,supersedes_id)
 VALUES(new_version,doc,app.next_label(latest.label,n),'draft',md_key,v.markdown_sha256,v.byte_size,v.source_format,
  v.title,v.summary,d.category_id,d.classification,v.labels,app.actor_id(),n,latest.id);
 -- The scan evidence is carried over unchanged: these are the same immutable bytes that
 -- were scanned when the source version was created, not a new upload.
 INSERT INTO app.version_sources(version_id,original_name,original_key,original_sha256,original_bytes,
  source_format,provenance_key,provenance_sha256,metadata_snapshot,scanner_version,signature_version,
  signature_date,scanned_at,scan_verdict,pipeline_revision,processing_state)
 VALUES(new_version,s.original_name,orig_key,s.original_sha256,s.original_bytes,s.source_format,
  prov_key,s.provenance_sha256,s.metadata_snapshot,s.scanner_version,s.signature_version,
  s.signature_date,s.scanned_at,s.scan_verdict,s.pipeline_revision,'preview_ready');
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id)
 VALUES(app.actor_id(),'document.rolled_back',doc,request_key);
 RETURN QUERY SELECT new_version,app.next_label(latest.label,n); END $$;
REVOKE ALL ON FUNCTION app.next_label(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.next_label(text,integer) TO intradocs_app,intradocs_workflow;
