-- S04/V1: restore an earlier version by opening a new draft from it.
--
-- History is never rewritten and nothing is republished directly. The restored text
-- re-enters the ordinary review path as a draft, so approval, indexing and the atomic
-- publication swap all happen exactly as they do for any other revision.
--
-- The artifacts are copied to fresh keys because markdown_key, original_key and
-- provenance_key are each UNIQUE; a version cannot share another version's storage. The
-- caller performs the copy and passes the new keys, so this function verifies the copy
-- instead of trusting it: the recorded hashes must equal the source version's hashes, and
-- the keys must follow the per-version naming pattern. That makes it impossible to open a
-- draft whose content differs from the version it claims to restore.
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained',
 'document.rolled_back'));

CREATE FUNCTION app.rollback_version(
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
 VALUES(new_version,doc,'0.'||n,'draft',md_key,v.markdown_sha256,v.byte_size,v.source_format,
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
 RETURN QUERY SELECT new_version,'0.'||n; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.rollback_version(uuid,uuid,uuid,uuid,text,text,text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.rollback_version(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rollback_version(uuid,uuid,uuid,uuid,text,text,text) TO intradocs_app;
