-- M3 additive; never edit the deployed 001–003 files.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='intradocs_workflow') THEN CREATE ROLE intradocs_workflow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS; END IF; END $$;
ALTER ROLE intradocs_workflow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
GRANT USAGE ON SCHEMA app TO intradocs_workflow;
ALTER TABLE app.categories ADD COLUMN approval_steps integer NOT NULL DEFAULT 1 CHECK(approval_steps IN (1,2));
ALTER TABLE app.categories ADD COLUMN review_days integer NOT NULL DEFAULT 180 CHECK(review_days BETWEEN 1 AND 3650);
ALTER TABLE app.categories ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE app.document_versions ADD COLUMN title text;
ALTER TABLE app.document_versions ADD COLUMN summary text;
ALTER TABLE app.document_versions ADD COLUMN category_id uuid REFERENCES app.categories(id);
ALTER TABLE app.document_versions ADD COLUMN classification text CHECK(classification IN ('public','internal','restricted','confidential'));
ALTER TABLE app.document_versions ADD COLUMN labels text[];
ALTER TABLE app.document_versions ADD COLUMN author_id text REFERENCES app.profiles(id);
ALTER TABLE app.document_versions ADD COLUMN version_number integer NOT NULL DEFAULT 1 CHECK(version_number>0);
ALTER TABLE app.document_versions ADD COLUMN supersedes_id uuid REFERENCES app.document_versions(id);
ALTER TABLE app.document_versions ADD COLUMN processing_state text NOT NULL DEFAULT 'preview_ready' CHECK(processing_state IN ('preview_ready','indexing','ready','failed'));
ALTER TABLE app.document_versions ADD COLUMN publication_state text NOT NULL DEFAULT 'unpublished' CHECK(publication_state IN ('unpublished','published','superseded','withdrawn'));
ALTER TABLE app.document_versions ADD COLUMN withdrawal_reason text CHECK(length(withdrawal_reason)<=2000);
UPDATE app.document_versions v SET title=d.title,summary=d.summary,category_id=d.category_id,classification=d.classification,labels=d.labels,author_id=d.owner_id,
 processing_state=CASE WHEN v.review_state='approved' THEN 'ready' ELSE 'preview_ready' END,
 publication_state=CASE WHEN d.current_version_id=v.id THEN 'published' WHEN v.review_state='approved' THEN 'superseded' ELSE 'unpublished' END FROM app.documents d WHERE d.id=v.document_id;
WITH numbered AS (SELECT id,row_number() OVER(PARTITION BY document_id ORDER BY created_at,id)::integer AS n FROM app.document_versions) UPDATE app.document_versions v SET version_number=n.n FROM numbered n WHERE v.id=n.id;
ALTER TABLE app.document_versions ALTER COLUMN title SET NOT NULL;
ALTER TABLE app.document_versions ALTER COLUMN summary SET NOT NULL;
ALTER TABLE app.document_versions ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE app.document_versions ALTER COLUMN classification SET NOT NULL;
ALTER TABLE app.document_versions ALTER COLUMN labels SET NOT NULL;
ALTER TABLE app.document_versions ALTER COLUMN author_id SET NOT NULL;
CREATE UNIQUE INDEX version_number_unique ON app.document_versions(document_id,version_number);
CREATE FUNCTION app.snapshot_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE d app.documents; BEGIN SELECT * INTO STRICT d FROM app.documents WHERE id=NEW.document_id;
 NEW.title:=coalesce(NEW.title,d.title); NEW.summary:=coalesce(NEW.summary,d.summary); NEW.category_id:=coalesce(NEW.category_id,d.category_id);
 NEW.classification:=coalesce(NEW.classification,d.classification); NEW.labels:=coalesce(NEW.labels,d.labels); NEW.author_id:=coalesce(NEW.author_id,d.owner_id);
 IF app.actor_id() IS NULL AND NEW.review_state='approved' THEN NEW.processing_state:='ready'; NEW.publication_state:='published'; END IF; RETURN NEW; END $$;
CREATE TRIGGER snapshot_version BEFORE INSERT ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.snapshot_version();
CREATE OR REPLACE FUNCTION app.protect_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF ROW(NEW.markdown_key,NEW.markdown_sha256,NEW.document_id,NEW.title,NEW.summary,NEW.category_id,NEW.classification,NEW.labels,NEW.author_id,NEW.byte_size,NEW.source_format,NEW.version_number,NEW.supersedes_id)
 IS DISTINCT FROM ROW(OLD.markdown_key,OLD.markdown_sha256,OLD.document_id,OLD.title,OLD.summary,OLD.category_id,OLD.classification,OLD.labels,OLD.author_id,OLD.byte_size,OLD.source_format,OLD.version_number,OLD.supersedes_id)
 THEN RAISE EXCEPTION 'Immutable version; create a revision' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TABLE app.approval_requests (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),version_id uuid NOT NULL UNIQUE REFERENCES app.document_versions(id),document_id uuid NOT NULL REFERENCES app.documents(id),revision_hash text NOT NULL,
 submitted_by text NOT NULL REFERENCES app.profiles(id),required_steps integer NOT NULL CHECK(required_steps IN (1,2)),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','changes_requested','rejected','cancelled')),
 submitted_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,review_at timestamptz NOT NULL,expires_at timestamptz,CHECK(expires_at IS NULL OR expires_at>=review_at));
CREATE TABLE app.approval_steps (
 request_id uuid NOT NULL REFERENCES app.approval_requests(id),stage integer NOT NULL CHECK(stage IN (1,2)),reviewer_id text NOT NULL REFERENCES app.profiles(id),decision text CHECK(decision IN ('approve','changes_requested','reject')),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=2000),decided_at timestamptz,PRIMARY KEY(request_id,stage),UNIQUE(request_id,reviewer_id),CHECK((decision IS NULL)=(decided_at IS NULL)),CHECK(decision NOT IN ('changes_requested','reject') OR length(trim(reason))>=10));
CREATE TABLE app.version_findings (
 version_id uuid NOT NULL REFERENCES app.document_versions(id),fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),rule text NOT NULL CHECK(rule IN ('private-key','credential-assignment','bearer-token','personal-id')),
 severity text NOT NULL CHECK(severity IN ('block','review')),source_line integer NOT NULL CHECK(source_line>0),resolved_by text REFERENCES app.profiles(id),justification text CHECK(length(justification) BETWEEN 10 AND 2000),resolved_at timestamptz,
 PRIMARY KEY(version_id,fingerprint),CHECK((resolved_by IS NULL)=(resolved_at IS NULL)),CHECK(resolved_by IS NULL OR (justification IS NOT NULL AND severity='review')));
CREATE TABLE app.publication_outbox (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),version_id uuid NOT NULL REFERENCES app.document_versions(id),pipeline text NOT NULL DEFAULT 'lexical-v1' CHECK(pipeline='lexical-v1'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','dead','cancelled')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(version_id,pipeline));
CREATE INDEX publication_pending_idx ON app.publication_outbox(available_at) WHERE state IN ('pending','running');
CREATE TABLE app.lexical_chunks (version_id uuid NOT NULL REFERENCES app.document_versions(id),ordinal integer NOT NULL CHECK(ordinal>=0),content text NOT NULL CHECK(length(content) BETWEEN 1 AND 16000),line_start integer NOT NULL CHECK(line_start>0),line_end integer NOT NULL CHECK(line_end>=line_start),search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple'::regconfig,content)) STORED,PRIMARY KEY(version_id,ordinal));
CREATE INDEX lexical_search_idx ON app.lexical_chunks USING gin(search_vector);
CREATE TABLE app.index_generations (version_id uuid PRIMARY KEY REFERENCES app.document_versions(id),pipeline text NOT NULL CHECK(pipeline='lexical-v1'),source_hash text NOT NULL,chunk_count integer NOT NULL CHECK(chunk_count>0),ready_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION app.classification_rank(value text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(array_position(ARRAY['public','internal','restricted','confidential'],value),99) $$;
CREATE FUNCTION app.category_floor(target uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 WITH RECURSIVE a AS (SELECT id,parent_id,minimum_classification,ARRAY[id] AS visited FROM app.categories WHERE id=target UNION ALL SELECT c.id,c.parent_id,c.minimum_classification,a.visited||c.id FROM app.categories c JOIN a ON c.id=a.parent_id WHERE NOT(c.id=ANY(a.visited)) AND cardinality(a.visited)<10)
 SELECT coalesce((SELECT minimum_classification FROM a ORDER BY app.classification_rank(minimum_classification) DESC LIMIT 1),'confidential') $$;
CREATE FUNCTION app.member_in_category(member text,target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=member AND p.active AND (p.scope_all OR EXISTS(
 WITH RECURSIVE a AS (SELECT id,parent_id,ARRAY[id] AS visited FROM app.categories WHERE id=target UNION ALL SELECT c.id,c.parent_id,a.visited||c.id FROM app.categories c JOIN a ON c.id=a.parent_id WHERE NOT(c.id=ANY(a.visited)) AND cardinality(a.visited)<10)
 SELECT 1 FROM a JOIN app.category_grants g ON g.category_id=a.id WHERE g.user_id=member))) $$;
CREATE FUNCTION app.member_can_classification(member text,doc uuid,category uuid,classification text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.member_in_category(member,category) AND (greatest(app.classification_rank(classification),app.classification_rank(app.category_floor(category)))<=2 OR EXISTS(SELECT 1 FROM app.profiles p JOIN app.document_grants g ON g.user_id=p.id WHERE p.id=member AND p.role<>'viewer' AND g.document_id=doc)) $$;
CREATE OR REPLACE FUNCTION app.private_document_access(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND app.actor_role()<>'viewer' AND (EXISTS(SELECT 1 FROM app.documents WHERE id=target AND owner_id=app.actor_id()) OR
 (app.actor_role() IN ('super_admin','knowledge_admin','reviewer') AND (EXISTS(SELECT 1 FROM app.approval_steps s JOIN app.approval_requests r ON r.id=s.request_id WHERE r.document_id=target AND s.reviewer_id=app.actor_id()) OR EXISTS(SELECT 1 FROM app.review_assignments WHERE document_id=target AND user_id=app.actor_id())))) $$;
CREATE OR REPLACE FUNCTION app.can_read_version(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=target AND app.member_can_classification(app.actor_id(),d.id,v.category_id,v.classification) AND (
 (v.review_state='approved' AND v.processing_state='ready' AND v.publication_state IN ('published','superseded') AND NOT d.withdrawn AND (v.expires_at IS NULL OR v.expires_at>now())) OR
 (app.actor_role()<>'viewer' AND (d.owner_id=app.actor_id() OR (app.actor_role() IN ('super_admin','knowledge_admin','reviewer') AND (
 EXISTS(SELECT 1 FROM app.approval_requests r JOIN app.approval_steps s ON s.request_id=r.id WHERE r.version_id=v.id AND s.reviewer_id=app.actor_id()) OR
 (NOT EXISTS(SELECT 1 FROM app.version_sources WHERE version_id=v.id) AND EXISTS(SELECT 1 FROM app.review_assignments WHERE document_id=d.id AND user_id=app.actor_id())))))))) $$;
CREATE OR REPLACE FUNCTION app.can_read_document(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.documents d WHERE d.id=target AND d.owner_id=app.actor_id() AND app.actor_active() AND app.actor_role()<>'viewer' AND app.member_can_classification(app.actor_id(),d.id,d.category_id,d.classification)) OR EXISTS(SELECT 1 FROM app.document_versions v WHERE v.document_id=target AND app.can_read_version(v.id)) $$;
CREATE FUNCTION app.is_active_version(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.current_version_id=v.id WHERE v.id=target AND NOT d.withdrawn AND v.review_state='approved' AND v.processing_state='ready' AND v.publication_state='published' AND (v.expires_at IS NULL OR v.expires_at>now())) AND app.can_read_version(target) $$;
CREATE FUNCTION app.reviewer_eligible(member text,target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id JOIN app.profiles p ON p.id=member WHERE v.id=target AND member<>v.author_id AND member<>d.owner_id AND p.active AND p.role IN ('super_admin','knowledge_admin','reviewer') AND app.member_can_classification(member,d.id,v.category_id,v.classification)) $$;
CREATE FUNCTION app.rule_steps(target uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 WITH RECURSIVE a AS (SELECT c.id,c.parent_id,c.approval_steps,ARRAY[c.id] AS visited FROM app.categories c JOIN app.document_versions v ON v.category_id=c.id WHERE v.id=target UNION ALL SELECT c.id,c.parent_id,c.approval_steps,a.visited||c.id FROM app.categories c JOIN a ON c.id=a.parent_id WHERE NOT(c.id=ANY(a.visited)) AND cardinality(a.visited)<10)
 SELECT CASE WHEN EXISTS(SELECT 1 FROM app.document_versions v WHERE v.id=target AND (greatest(app.classification_rank(v.classification),app.classification_rank(app.category_floor(v.category_id)))>2 OR EXISTS(SELECT 1 FROM unnest(v.labels) l WHERE lower(l)='kritikal'))) OR EXISTS(SELECT 1 FROM a WHERE approval_steps=2) THEN 2 ELSE 1 END $$;

CREATE FUNCTION app.review_candidates(target uuid) RETURNS TABLE(id text,name text,role text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=target AND d.owner_id=app.actor_id() AND app.can_read_version(v.id) AND app.actor_role()<>'viewer') THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 RETURN QUERY SELECT p.id,p.name,p.role FROM app.profiles p WHERE app.reviewer_eligible(p.id,target) ORDER BY p.name LIMIT 100; END $$;
CREATE FUNCTION app.submit_version(target uuid,reviewers text[],review_date timestamptz,expiry_date timestamptz,markdown text,findings jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; d app.documents; req uuid; stages integer; i integer; f jsonb; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 SELECT * INTO v FROM app.document_versions WHERE id=target;
 SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE;
 SELECT * INTO v FROM app.document_versions WHERE id=target FOR UPDATE;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_version(target) OR app.actor_role()='viewer' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF v.review_state<>'draft' OR v.id<>(SELECT id FROM app.document_versions WHERE document_id=d.id ORDER BY version_number DESC LIMIT 1) OR d.withdrawn THEN RAISE EXCEPTION 'Draft changed' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.version_sources WHERE version_id=target AND scan_verdict='clean' AND processing_state='preview_ready') THEN RAISE EXCEPTION 'Source scan evidence required' USING ERRCODE='23514'; END IF;
 IF markdown IS NULL OR octet_length(markdown)>2097152 OR encode(public.digest(markdown,'sha256'),'hex')<>v.markdown_sha256 THEN RAISE EXCEPTION 'Source integrity mismatch' USING ERRCODE='23514'; END IF;
 stages:=app.rule_steps(target);
 IF reviewers IS NULL OR cardinality(reviewers)<>stages OR (SELECT count(DISTINCT x) FROM unnest(reviewers) x)<>stages THEN RAISE EXCEPTION 'Reviewer count invalid' USING ERRCODE='23514'; END IF;
 FOR i IN 1..stages LOOP IF NOT app.reviewer_eligible(reviewers[i],target) THEN RAISE EXCEPTION 'Reviewer unavailable' USING ERRCODE='23514'; END IF; END LOOP;
 IF review_date IS NULL THEN SELECT now()+make_interval(days=>review_days) INTO review_date FROM app.categories WHERE id=v.category_id; END IF;
 IF review_date<=now() OR (expiry_date IS NOT NULL AND (expiry_date<=now() OR expiry_date<review_date)) THEN RAISE EXCEPTION 'Dates invalid' USING ERRCODE='23514'; END IF;
 IF findings IS NULL OR jsonb_typeof(findings)<>'array' OR jsonb_array_length(findings)>100 THEN RAISE EXCEPTION 'Findings invalid' USING ERRCODE='23514'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(findings) LOOP
 INSERT INTO app.version_findings(version_id,fingerprint,rule,severity,source_line) VALUES(target,f->>'fingerprint',f->>'rule',f->>'severity',(f->>'line')::integer); END LOOP;
 IF markdown ~ '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' OR EXISTS(SELECT 1 FROM app.version_findings WHERE version_id=target AND severity='block') THEN RAISE EXCEPTION 'Remove blocking secret findings in a new version' USING ERRCODE='23514'; END IF;
 INSERT INTO app.approval_requests(version_id,document_id,revision_hash,submitted_by,required_steps,review_at,expires_at) VALUES(target,d.id,v.markdown_sha256,app.actor_id(),stages,review_date,expiry_date) RETURNING id INTO req;
 FOR i IN 1..stages LOOP INSERT INTO app.approval_steps(request_id,stage,reviewer_id) VALUES(req,i,reviewers[i]); END LOOP;
 UPDATE app.document_versions SET review_state='in_review' WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.submitted',d.id,req); RETURN req; END $$;
CREATE FUNCTION app.resolve_finding(target uuid,fingerprint_value text,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE doc uuid; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT document_id INTO doc FROM app.document_versions WHERE id=target; PERFORM 1 FROM app.documents WHERE id=doc FOR UPDATE;
 IF NOT app.can_read_version(target) OR NOT app.reviewer_eligible(app.actor_id(),target) OR NOT EXISTS(SELECT 1 FROM app.approval_requests r JOIN app.approval_steps s ON s.request_id=r.id WHERE r.version_id=target AND r.state='pending' AND s.reviewer_id=app.actor_id()) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF reason IS NULL OR length(trim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'Justification required' USING ERRCODE='23514'; END IF;
 UPDATE app.version_findings SET resolved_by=app.actor_id(),justification=reason,resolved_at=now() WHERE version_id=target AND fingerprint=fingerprint_value AND severity='review' AND resolved_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Finding changed or blocked' USING ERRCODE='40001'; END IF;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'review.finding_resolved',doc,public.gen_random_uuid()); END $$;
CREATE FUNCTION app.decide_version(target uuid,decision_value text,reason_value text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; d app.documents; r app.approval_requests; s app.approval_steps; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT * INTO v FROM app.document_versions WHERE id=target; SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE; SELECT * INTO v FROM app.document_versions WHERE id=target;
 SELECT * INTO r FROM app.approval_requests WHERE version_id=target FOR UPDATE;
 IF r.id IS NULL OR NOT app.can_read_version(target) OR NOT app.reviewer_eligible(app.actor_id(),target) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO s FROM app.approval_steps WHERE request_id=r.id AND reviewer_id=app.actor_id();
 IF s.request_id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF r.state<>'pending' OR s.decision IS NOT NULL OR d.withdrawn OR v.markdown_sha256<>r.revision_hash OR v.review_state<>'in_review' THEN RAISE EXCEPTION 'Review changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM app.approval_steps WHERE request_id=r.id AND stage<s.stage AND decision IS DISTINCT FROM 'approve') THEN RAISE EXCEPTION 'Previous stage incomplete' USING ERRCODE='40001'; END IF;
 IF decision_value IS NULL OR decision_value NOT IN ('approve','changes_requested','reject') OR reason_value IS NULL OR length(reason_value)>2000 OR (decision_value<>'approve' AND length(trim(reason_value))<10) THEN RAISE EXCEPTION 'Invalid decision or reason' USING ERRCODE='23514'; END IF;
 IF decision_value='approve' AND EXISTS(SELECT 1 FROM app.version_findings WHERE version_id=target AND resolved_at IS NULL) THEN RAISE EXCEPTION 'Unresolved findings' USING ERRCODE='23514'; END IF;
 UPDATE app.approval_steps SET decision=decision_value,reason=reason_value,decided_at=now() WHERE request_id=r.id AND stage=s.stage;
 IF decision_value<>'approve' THEN
 UPDATE app.approval_requests SET state=CASE WHEN decision_value='reject' THEN 'rejected' ELSE 'changes_requested' END,decided_at=now() WHERE id=r.id;
 UPDATE app.document_versions SET review_state=CASE WHEN decision_value='reject' THEN 'rejected' ELSE 'changes_requested' END WHERE id=target;
 ELSIF s.stage=r.required_steps THEN
 UPDATE app.approval_requests SET state='approved',decided_at=now() WHERE id=r.id;
 UPDATE app.document_versions SET review_state='approved',processing_state='indexing',approved_by=app.actor_id(),approved_by_label=(SELECT name FROM app.profiles WHERE id=app.actor_id()),approved_at=now(),review_at=r.review_at,expires_at=r.expires_at WHERE id=target;
 INSERT INTO app.publication_outbox(version_id) VALUES(target) ON CONFLICT DO NOTHING; END IF;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'review.'||decision_value,d.id,public.gen_random_uuid());
 RETURN CASE WHEN decision_value<>'approve' THEN decision_value WHEN s.stage=r.required_steps THEN 'indexing' ELSE 'in_review' END; END $$;
CREATE FUNCTION app.claim_publication() RETURNS TABLE(job_id uuid,lease_token uuid,version_id uuid,document_id uuid,markdown_key text,markdown_hash text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.publication_outbox; token uuid; BEGIN
 UPDATE app.publication_outbox SET state='dead',error_code='lease_exhausted' WHERE state='running' AND lease_until<now() AND attempts>=5;
 SELECT * INTO j FROM app.publication_outbox o WHERE (o.state='pending' OR (o.state='running' AND o.lease_until<now())) AND o.available_at<=now() AND o.attempts<5 ORDER BY o.available_at,o.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF; token:=public.gen_random_uuid();
 UPDATE app.publication_outbox SET state='running',attempts=attempts+1,lease_token=token,lease_until=now()+interval '90 seconds' WHERE id=j.id;
 RETURN QUERY SELECT j.id,token,v.id,v.document_id,v.markdown_key,v.markdown_sha256 FROM app.document_versions v WHERE v.id=j.version_id; END $$;
CREATE FUNCTION app.publish_lexical(job uuid,token uuid,chunks jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.publication_outbox; v app.document_versions; d app.documents; r app.approval_requests; full_text text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT * INTO j FROM app.publication_outbox WHERE id=job;
 IF j.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v FROM app.document_versions WHERE id=j.version_id; SELECT * INTO d FROM app.documents WHERE id=v.document_id FOR UPDATE;
 SELECT * INTO v FROM app.document_versions WHERE id=j.version_id; SELECT * INTO j FROM app.publication_outbox WHERE id=job FOR UPDATE;
 IF j.state='done' THEN RETURN; END IF;
 IF j.state<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=now() THEN RAISE EXCEPTION 'Stale lease' USING ERRCODE='40001'; END IF;
 SELECT * INTO r FROM app.approval_requests WHERE version_id=v.id;
 IF d.withdrawn OR v.review_state<>'approved' OR (v.expires_at IS NOT NULL AND v.expires_at<=now()) OR (r.id IS NOT NULL AND (r.state<>'approved' OR r.revision_hash<>v.markdown_sha256 OR (SELECT count(*) FROM app.approval_steps WHERE request_id=r.id AND decision='approve')<>r.required_steps OR EXISTS(SELECT 1 FROM app.approval_steps s WHERE s.request_id=r.id AND NOT app.reviewer_eligible(s.reviewer_id,v.id)) OR app.rule_steps(v.id)>r.required_steps)) OR EXISTS(SELECT 1 FROM app.document_versions n WHERE n.document_id=d.id AND n.version_number>v.version_number AND n.review_state IN ('in_review','approved')) THEN
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
CREATE FUNCTION app.fail_publication(job uuid,token uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE vid uuid; BEGIN
 UPDATE app.publication_outbox SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,available_at=now()+make_interval(secs=>least(300,5*power(2,attempts)::integer)),lease_until=NULL,error_code='index_failed' WHERE id=job AND state='running' AND lease_token=token RETURNING version_id INTO vid;
 IF vid IS NOT NULL THEN UPDATE app.document_versions SET processing_state='failed' WHERE id=vid AND publication_state='unpublished'; END IF; END $$;
CREATE FUNCTION app.retry_publication(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE d app.documents; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT d0.* INTO d FROM app.documents d0 JOIN app.document_versions v ON v.document_id=d0.id WHERE v.id=target FOR UPDATE OF d0;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_version(target) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF d.withdrawn OR NOT EXISTS(SELECT 1 FROM app.approval_requests WHERE version_id=target AND state='approved') THEN RAISE EXCEPTION 'Approval invalid' USING ERRCODE='40001'; END IF;
 UPDATE app.publication_outbox SET state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE version_id=target AND state='dead';
 IF NOT FOUND THEN RAISE EXCEPTION 'Only dead jobs support manual retry' USING ERRCODE='40001'; END IF;
 UPDATE app.document_versions SET processing_state='indexing' WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'publication.retried',d.id,public.gen_random_uuid()); END $$;
CREATE FUNCTION app.withdraw_document(target uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE d app.documents; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1); SELECT * INTO d FROM app.documents WHERE id=target FOR UPDATE;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_document(target) OR app.actor_role()='viewer' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF reason IS NULL OR length(trim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'Withdrawal reason required' USING ERRCODE='23514'; END IF;
 IF d.withdrawn THEN RETURN; END IF; UPDATE app.documents SET withdrawn=true WHERE id=target;
 UPDATE app.document_versions SET publication_state='withdrawn',withdrawal_reason=reason WHERE document_id=target AND publication_state='published';
 UPDATE app.publication_outbox SET state='cancelled' WHERE version_id IN(SELECT id FROM app.document_versions WHERE document_id=target) AND state IN ('pending','running','dead');
 UPDATE app.approval_requests SET state='cancelled',decided_at=now() WHERE document_id=target AND state='pending';
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.withdrawn',target,public.gen_random_uuid()); END $$;
CREATE OR REPLACE FUNCTION app.check_publication_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.document_versions v WHERE v.id=NEW.current_version_id AND v.document_id=NEW.id AND v.review_state='approved' AND v.approved_by<>NEW.owner_id AND v.processing_state='ready') THEN RAISE EXCEPTION 'Publication requires approval and ready index' USING ERRCODE='23514'; END IF; RETURN NULL; END $$;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN ('document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed'));
INSERT INTO app.publication_outbox(version_id) SELECT v.id FROM app.document_versions v JOIN app.documents d ON d.current_version_id=v.id WHERE v.review_state='approved' AND NOT d.withdrawn AND (v.expires_at IS NULL OR v.expires_at>now());
GRANT SELECT ON app.approval_requests,app.approval_steps,app.version_sources TO intradocs_policy;
GRANT SELECT ON app.profiles,app.categories,app.category_grants,app.document_grants,app.review_assignments,app.version_sources TO intradocs_workflow;
GRANT SELECT,INSERT,UPDATE ON app.documents,app.document_versions,app.approval_requests,app.approval_steps,app.version_findings,app.publication_outbox,app.index_generations TO intradocs_workflow;
GRANT SELECT,INSERT,DELETE ON app.lexical_chunks TO intradocs_workflow;
GRANT INSERT ON app.audit_events TO intradocs_workflow;
GRANT USAGE ON SEQUENCE app.audit_events_id_seq TO intradocs_workflow;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO intradocs_workflow;
GRANT CREATE ON SCHEMA app TO intradocs_policy,intradocs_workflow;
ALTER FUNCTION app.category_floor(uuid) OWNER TO intradocs_policy;
ALTER FUNCTION app.member_in_category(text,uuid) OWNER TO intradocs_policy;
ALTER FUNCTION app.member_can_classification(text,uuid,uuid,text) OWNER TO intradocs_policy;
ALTER FUNCTION app.is_active_version(uuid) OWNER TO intradocs_policy;
ALTER FUNCTION app.reviewer_eligible(text,uuid) OWNER TO intradocs_policy;
ALTER FUNCTION app.rule_steps(uuid) OWNER TO intradocs_policy;
DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY ARRAY['review_candidates(uuid)','submit_version(uuid,text[],timestamp with time zone,timestamp with time zone,text,jsonb)','resolve_finding(uuid,text,text)','decide_version(uuid,text,text)','claim_publication()','publish_lexical(uuid,uuid,jsonb)','fail_publication(uuid,uuid)','retry_publication(uuid)','withdraw_document(uuid,text)'] LOOP EXECUTE 'ALTER FUNCTION app.'||f||' OWNER TO intradocs_workflow'; END LOOP; END $$;
REVOKE CREATE ON SCHEMA app FROM intradocs_policy,intradocs_workflow;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.classification_rank(text),app.category_floor(uuid),app.member_in_category(text,uuid),app.member_can_classification(text,uuid,uuid,text),app.reviewer_eligible(text,uuid),app.rule_steps(uuid),app.is_active_version(uuid) TO intradocs_policy,intradocs_workflow;
GRANT EXECUTE ON FUNCTION app.classification_rank(text),app.is_active_version(uuid),app.rule_steps(uuid),app.review_candidates(uuid),app.submit_version(uuid,text[],timestamptz,timestamptz,text,jsonb),app.resolve_finding(uuid,text,text),app.decide_version(uuid,text,text),app.retry_publication(uuid),app.withdraw_document(uuid,text) TO intradocs_app;
GRANT EXECUTE ON FUNCTION app.claim_publication(),app.publish_lexical(uuid,uuid,jsonb),app.fail_publication(uuid,uuid) TO intradocs_worker;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['approval_requests','approval_steps','version_findings','publication_outbox','lexical_chunks','index_generations'] LOOP EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t); END LOOP; END $$;
CREATE POLICY requests_read ON app.approval_requests FOR SELECT TO intradocs_app USING(app.can_read_version(version_id));
CREATE POLICY steps_read ON app.approval_steps FOR SELECT TO intradocs_app USING(EXISTS(SELECT 1 FROM app.approval_requests r WHERE r.id=request_id));
CREATE POLICY findings_read ON app.version_findings FOR SELECT TO intradocs_app USING(app.can_read_version(version_id));
CREATE POLICY outbox_read ON app.publication_outbox FOR SELECT TO intradocs_app USING(app.can_read_version(version_id) AND app.private_document_access((SELECT document_id FROM app.document_versions WHERE id=version_id)));
CREATE POLICY chunks_read ON app.lexical_chunks FOR SELECT TO intradocs_app USING(app.is_active_version(version_id));
CREATE POLICY generations_read ON app.index_generations FOR SELECT TO intradocs_app USING(app.is_active_version(version_id));
GRANT SELECT ON app.approval_requests,app.approval_steps,app.version_findings,app.publication_outbox,app.lexical_chunks,app.index_generations TO intradocs_app;
