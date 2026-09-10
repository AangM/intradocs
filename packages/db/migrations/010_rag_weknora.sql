-- M4: WeKnora export tracking. IntraDocs stays the system of record and the policy
-- gate; WeKnora is a downstream FOLLOWER of the lexical cutover and never decides
-- publication state. Nothing here may set publication_state, processing_state or
-- current_version_id: a WeKnora outage must not stop a document from publishing,
-- and reader plus lexical search keep working when the RAG side is down.
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN ('document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed','rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected'));

-- The actor-independent half of app.is_active_version. The worker has no actor and
-- no table access, so index eligibility must be expressible without can_read_version.
-- app.is_active_version is deliberately left untouched; an integration test asserts
-- is_active_version(v) = is_indexable_version(v) AND can_read_version(v) so the two
-- cannot drift apart.
CREATE FUNCTION app.is_indexable_version(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.current_version_id=v.id
  WHERE v.id=target AND NOT d.withdrawn AND v.review_state='approved'
  AND v.processing_state='ready' AND v.publication_state='published'
  AND (v.expires_at IS NULL OR v.expires_at>now()))
$$;

-- One row per version. knowledge_id is UNIQUE so a forged or replayed WeKnora id
-- can never resolve to a second version. source_hash records exactly which bytes
-- were indexed, which is what makes re-export idempotent.
CREATE TABLE app.rag_index_entries (
 version_id uuid PRIMARY KEY REFERENCES app.document_versions(id),
 document_id uuid NOT NULL REFERENCES app.documents(id),
 knowledge_id text NOT NULL UNIQUE CHECK(length(knowledge_id) BETWEEN 1 AND 200),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 chunk_count integer NOT NULL CHECK(chunk_count>0),
 exported_at timestamptz NOT NULL DEFAULT now());

-- Separate from app.publication_outbox on purpose. That queue and claim_publication()
-- are the tested critical path for M3; a RAG bug must not be able to reach them.
CREATE TABLE app.rag_export_queue (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 version_id uuid NOT NULL REFERENCES app.document_versions(id) UNIQUE,
 operation text NOT NULL CHECK(operation IN ('upsert','remove')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','dead','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX rag_queue_ready_idx ON app.rag_export_queue(available_at,id) WHERE state IN ('pending','running');

-- Pull-based reconciliation rather than a trigger on publish_lexical: one code path
-- covers new versions, revisions, revoke, expiry and superseding, and re-running it
-- is always safe. A running job is never disturbed; the next pass picks up the change.
CREATE FUNCTION app.reconcile_rag_exports() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE queued integer:=0; n integer; BEGIN
 PERFORM pg_advisory_xact_lock(719284,1);
 INSERT INTO app.rag_export_queue(version_id,operation)
  SELECT v.id,'upsert' FROM app.document_versions v
  WHERE app.is_indexable_version(v.id)
   AND NOT EXISTS(SELECT 1 FROM app.rag_index_entries e WHERE e.version_id=v.id AND e.source_hash=v.markdown_sha256)
 ON CONFLICT(version_id) DO UPDATE SET operation='upsert',state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL
  WHERE rag_export_queue.state<>'running';
 GET DIAGNOSTICS n=ROW_COUNT; queued:=queued+n;
 INSERT INTO app.rag_export_queue(version_id,operation)
  SELECT e.version_id,'remove' FROM app.rag_index_entries e WHERE NOT app.is_indexable_version(e.version_id)
 ON CONFLICT(version_id) DO UPDATE SET operation='remove',state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL
  WHERE rag_export_queue.state<>'running';
 GET DIAGNOSTICS n=ROW_COUNT; queued:=queued+n;
 RETURN queued; END $$;

-- Re-check eligibility at claim time as well as at completion. Without this a version
-- revoked between reconciliation and claim would have its bytes handed to WeKnora
-- before completion could refuse it. A downgraded job returns no markdown_key, so the
-- worker has nothing to export even if it ignores the operation field.
CREATE FUNCTION app.claim_rag_export() RETURNS TABLE(job_id uuid,lease uuid,version uuid,document uuid,markdown_key text,markdown_hash text,operation text,knowledge_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.rag_export_queue; token uuid; BEGIN
 UPDATE app.rag_export_queue SET state='dead',error_code='lease_exhausted' WHERE state='running' AND lease_until<now() AND attempts>=5;
 SELECT * INTO j FROM app.rag_export_queue q
  WHERE (q.state='pending' OR (q.state='running' AND q.lease_until<now())) AND q.available_at<=now() AND q.attempts<5
  ORDER BY q.available_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 IF j.operation='upsert' AND NOT app.is_indexable_version(j.version_id) THEN
  UPDATE app.rag_export_queue SET operation='remove' WHERE id=j.id; j.operation:='remove';
 END IF;
 token:=public.gen_random_uuid();
 UPDATE app.rag_export_queue SET state='running',attempts=attempts+1,lease_token=token,lease_until=now()+interval '120 seconds' WHERE id=j.id;
 RETURN QUERY SELECT j.id,token,v.id,v.document_id,
  CASE WHEN j.operation='upsert' THEN v.markdown_key END,
  CASE WHEN j.operation='upsert' THEN v.markdown_sha256 END,
  j.operation,(SELECT e.knowledge_id FROM app.rag_index_entries e WHERE e.version_id=v.id)
  FROM app.document_versions v WHERE v.id=j.version_id; END $$;

-- Authoritative re-check. Eligibility is evaluated again here, so a revoke that lands
-- while the worker was talking to WeKnora removes the entry instead of recording it.
-- hash must equal the version's current markdown_sha256, which stops stale bytes from
-- being registered as the live index.
CREATE FUNCTION app.complete_rag_export(job uuid,token uuid,knowledge text,hash text,chunks integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.rag_export_queue; v app.document_versions; actor text; BEGIN
 SELECT * INTO j FROM app.rag_export_queue WHERE id=job FOR UPDATE;
 IF j.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF j.state='done' THEN RETURN; END IF;
 IF j.state<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=now() THEN RAISE EXCEPTION 'Stale lease' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM app.document_versions WHERE id=j.version_id;
 actor:=coalesce(v.approved_by,v.author_id);
 IF j.operation='remove' OR NOT app.is_indexable_version(v.id) THEN
  DELETE FROM app.rag_index_entries WHERE version_id=v.id;
  UPDATE app.rag_export_queue SET state='done',lease_until=NULL,error_code=NULL WHERE id=job;
  INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(actor,'rag.unindexed',v.document_id,job);
  RETURN;
 END IF;
 IF knowledge IS NULL OR length(knowledge) NOT BETWEEN 1 AND 200 OR hash IS DISTINCT FROM v.markdown_sha256 OR chunks IS NULL OR chunks<1 THEN
  RAISE EXCEPTION 'Invalid export result' USING ERRCODE='23514';
 END IF;
 INSERT INTO app.rag_index_entries(version_id,document_id,knowledge_id,source_hash,chunk_count)
  VALUES(v.id,v.document_id,knowledge,hash,chunks)
  ON CONFLICT(version_id) DO UPDATE SET knowledge_id=excluded.knowledge_id,source_hash=excluded.source_hash,chunk_count=excluded.chunk_count,exported_at=now();
 UPDATE app.rag_export_queue SET state='done',lease_until=NULL,error_code=NULL WHERE id=job;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(actor,'rag.exported',v.document_id,job); END $$;

-- Mirrors fail_publication's bounded backoff, but deliberately does NOT touch
-- document_versions.processing_state: a failed RAG export is not a failed publication.
CREATE FUNCTION app.fail_rag_export(job uuid,token uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 UPDATE app.rag_export_queue SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,
  available_at=now()+make_interval(secs=>least(300,5*power(2,attempts)::integer)),lease_until=NULL,error_code='export_failed'
  WHERE id=job AND state='running' AND lease_token=token; END $$;

GRANT CREATE ON SCHEMA app TO intradocs_policy,intradocs_workflow;
ALTER FUNCTION app.is_indexable_version(uuid) OWNER TO intradocs_policy;
DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY ARRAY['reconcile_rag_exports()','claim_rag_export()','complete_rag_export(uuid,uuid,text,text,integer)','fail_rag_export(uuid,uuid)'] LOOP EXECUTE 'ALTER FUNCTION app.'||f||' OWNER TO intradocs_workflow'; END LOOP; END $$;
REVOKE CREATE ON SCHEMA app FROM intradocs_policy,intradocs_workflow;
REVOKE ALL ON FUNCTION app.is_indexable_version(uuid),app.reconcile_rag_exports(),app.claim_rag_export(),app.complete_rag_export(uuid,uuid,text,text,integer),app.fail_rag_export(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_indexable_version(uuid) TO intradocs_app,intradocs_policy,intradocs_workflow;
-- The worker still gets no table access at all; it only gains these four entry points.
GRANT EXECUTE ON FUNCTION app.reconcile_rag_exports(),app.claim_rag_export(),app.complete_rag_export(uuid,uuid,text,text,integer),app.fail_rag_export(uuid,uuid) TO intradocs_worker;

ALTER TABLE app.rag_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rag_index_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.rag_export_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rag_export_queue FORCE ROW LEVEL SECURITY;
-- Retrieval re-validates every WeKnora hit through this policy, so a citation for a
-- withdrawn, expired, superseded or out-of-scope version returns no row and is dropped.
CREATE POLICY rag_entries_read ON app.rag_index_entries FOR SELECT TO intradocs_app USING(app.is_active_version(version_id));
GRANT SELECT ON app.rag_index_entries TO intradocs_app;
-- app.rag_export_queue stays invisible to the application role: it carries no content,
-- and its contents would reveal which documents exist outside the caller's scope.
