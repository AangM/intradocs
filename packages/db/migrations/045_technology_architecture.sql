-- Technology Architecture (TOGAF technology layer): elements and relations imported from
-- Sparx EA, scoped to a category like documents are. Readers see the elements of the
-- categories they may read.
--
-- An import goes through review exactly as a document does. It is a proposed change set:
-- the original file is scanned and kept immutable, the parsed payload and its diff are
-- stored, and a second knowledge/super admin of the category -- never the proposer --
-- approves or rejects it. Only an approved import changes the model; it upserts by the
-- Sparx GUID, never deletes an element (one missing from a later export is reported,
-- because the model may simply be split), and records every field it changes.

CREATE TABLE app.ta_elements (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 category_id uuid NOT NULL REFERENCES app.categories(id),
 external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK (kind IN ('location','network_segment','network_device','server','storage','virtual_machine','platform','software')),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 hostname text CHECK (hostname IS NULL OR length(hostname) <= 253),
 ip_address text CHECK (ip_address IS NULL OR length(ip_address) <= 64),
 environment text CHECK (environment IS NULL OR environment IN ('production','staging','development','dr')),
 location text CHECK (location IS NULL OR length(location) <= 300),
 os text CHECK (os IS NULL OR length(os) <= 300),
 os_version text CHECK (os_version IS NULL OR length(os_version) <= 300),
 status text NOT NULL CHECK (status IN ('planned','active','retiring','retired')),
 owner_label text CHECK (owner_label IS NULL OR length(owner_label) <= 300),
 end_of_support date,
 description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
 attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
 source text NOT NULL DEFAULT 'xmi' CHECK (source IN ('xmi','csv')),
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL REFERENCES app.profiles(id),
 UNIQUE (category_id, external_id)
);
CREATE INDEX ta_elements_category ON app.ta_elements(category_id, kind);
CREATE INDEX ta_elements_hostname ON app.ta_elements(lower(hostname));
CREATE TABLE app.ta_relations (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 category_id uuid NOT NULL REFERENCES app.categories(id),
 source_id uuid NOT NULL REFERENCES app.ta_elements(id) ON DELETE CASCADE,
 target_id uuid NOT NULL REFERENCES app.ta_elements(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('hosts','runs_on','depends_on','connects_to','located_in','stores_on')),
 external_id text CHECK (external_id IS NULL OR length(external_id) <= 80),
 CHECK (source_id <> target_id),
 UNIQUE (source_id, target_id, kind)
);
CREATE INDEX ta_relations_target ON app.ta_relations(target_id);
CREATE TABLE app.ta_imports (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 category_id uuid NOT NULL REFERENCES app.categories(id),
 filename text NOT NULL CHECK (length(filename) <= 255),
 format text NOT NULL CHECK (format IN ('xmi','csv')),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 -- The original file, kept immutable in the blob store, and its ClamAV evidence.
 blob_key text NOT NULL CHECK (length(blob_key) <= 300),
 scan jsonb NOT NULL,
 -- The parsed change set and its diff against the model when it was proposed.
 payload jsonb NOT NULL,
 diff jsonb NOT NULL DEFAULT '[]'::jsonb,
 summary jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','rejected','withdrawn')),
 imported_by text NOT NULL REFERENCES app.profiles(id),
 imported_at timestamptz NOT NULL DEFAULT now(),
 decided_by text REFERENCES app.profiles(id),
 decided_at timestamptz,
 decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000)
);
CREATE INDEX ta_imports_pending ON app.ta_imports(category_id) WHERE state = 'pending';
-- What each approved import did to each element: the fields that changed, old and new.
CREATE TABLE app.ta_element_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 element_id uuid NOT NULL REFERENCES app.ta_elements(id) ON DELETE CASCADE,
 import_id uuid NOT NULL REFERENCES app.ta_imports(id),
 change text NOT NULL CHECK (change IN ('created','updated')),
 fields jsonb NOT NULL DEFAULT '{}'::jsonb,
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ta_element_changes_element ON app.ta_element_changes(element_id, changed_at DESC);
-- The search-index copy of each element (WeKnora knowledge id + the card's hash), kept
-- by the worker: an element whose card changed is re-exported, nothing else.
CREATE TABLE app.ta_index_entries (
 element_id uuid PRIMARY KEY REFERENCES app.ta_elements(id) ON DELETE CASCADE,
 knowledge_id text NOT NULL,
 card_sha256 text NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.ta_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ta_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ta_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ta_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ta_element_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ta_elements_read ON app.ta_elements FOR SELECT TO intradocs_app USING (app.in_category(category_id));
CREATE POLICY ta_relations_read ON app.ta_relations FOR SELECT TO intradocs_app USING (app.in_category(category_id));
CREATE POLICY ta_imports_read ON app.ta_imports FOR SELECT TO intradocs_app
 USING (app.in_category(category_id) AND app.actor_role() IN ('super_admin','knowledge_admin'));
CREATE POLICY ta_index_read ON app.ta_index_entries FOR SELECT TO intradocs_app
 USING (EXISTS (SELECT 1 FROM app.ta_elements e WHERE e.id = element_id AND app.in_category(e.category_id)));
CREATE POLICY ta_changes_read ON app.ta_element_changes FOR SELECT TO intradocs_app
 USING (EXISTS (SELECT 1 FROM app.ta_elements e WHERE e.id = element_id AND app.in_category(e.category_id)));
GRANT SELECT ON app.ta_elements, app.ta_relations, app.ta_imports, app.ta_index_entries, app.ta_element_changes TO intradocs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ta_elements, app.ta_relations, app.ta_imports, app.ta_index_entries TO intradocs_workflow;
GRANT SELECT, INSERT ON app.ta_element_changes TO intradocs_workflow;
GRANT USAGE ON SEQUENCE app.ta_element_changes_id_seq TO intradocs_workflow;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed','rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained','document.rolled_back','access.requested','access.decided','rag.answer_helpful','rag.answer_unhelpful','user.invited','user.invitation_revoked','user.invitation_accepted','role.created','role.updated','role.archived','document.reaffirmed','document.archived_by_policy','audit.exported','ta.import_submitted','ta.imported','ta.import_rejected','ta.import_withdrawn'));

-- Propose: an admin in scope submits a scanned, stored, parsed import with its diff.
CREATE FUNCTION app.ta_submit_import(target_category uuid, payload jsonb, diff jsonb, file_name text, file_format text, file_sha text, file_key text, scan_evidence jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE new_id uuid; BEGIN
 IF app.actor_role() IS NULL OR app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(target_category) THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 IF file_format NOT IN ('xmi','csv') OR file_sha !~ '^[0-9a-f]{64}$' OR file_key IS NULL OR length(file_key) > 300
  OR scan_evidence->>'verdict' IS DISTINCT FROM 'clean' OR scan_evidence->>'sha256' IS DISTINCT FROM file_sha
  OR jsonb_typeof(payload->'elements') IS DISTINCT FROM 'array' OR jsonb_typeof(payload->'relations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(payload->'elements') NOT BETWEEN 1 AND 5000 OR jsonb_array_length(payload->'relations') > 20000
  OR jsonb_typeof(diff) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Payload invalid' USING ERRCODE='23514'; END IF;
 -- One open proposal per file and category: resubmitting the same bytes is not a second change.
 IF EXISTS (SELECT 1 FROM app.ta_imports WHERE category_id=target_category AND sha256=file_sha AND state='pending') THEN
  RAISE EXCEPTION 'Already pending' USING ERRCODE='23505'; END IF;
 INSERT INTO app.ta_imports(category_id,filename,format,sha256,summary,imported_by,state,payload,diff,blob_key,scan)
 VALUES(target_category,left(file_name,255),file_format,file_sha,
  jsonb_build_object('elements',jsonb_array_length(payload->'elements'),'relations',jsonb_array_length(payload->'relations'),
   'skipped',coalesce(payload->'skipped','[]'::jsonb)),
  app.actor_id(),'pending',payload,diff,file_key,scan_evidence)
 RETURNING id INTO new_id;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'ta.import_submitted',new_id);
 RETURN new_id;
END $$;

-- The proposer may take their own proposal back while it is pending.
CREATE FUNCTION app.ta_withdraw_import(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.ta_imports SET state='withdrawn', decided_by=app.actor_id(), decided_at=now()
 WHERE id=target AND state='pending' AND imported_by=app.actor_id() AND app.in_category(category_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'ta.import_withdrawn',target);
END $$;

-- Decide: a different admin in scope approves (the change set is applied in the same
-- transaction) or rejects with a reason. Returns what was applied.
CREATE FUNCTION app.ta_decide_import(target uuid, approve boolean, note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE
 imp app.ta_imports; e jsonb; r jsonb; existing app.ta_elements;
 created integer := 0; updated integer := 0; unchanged integer := 0; rel_removed integer := 0; missing integer := 0;
 src uuid; tgt uuid; rid uuid; ids uuid[] := '{}'; keep uuid[] := '{}'; changed jsonb; result_summary jsonb;
BEGIN
 SELECT * INTO imp FROM app.ta_imports WHERE id=target FOR UPDATE;
 IF imp.id IS NULL OR imp.state <> 'pending' OR NOT app.in_category(imp.category_id)
  OR app.actor_role() IS NULL OR app.actor_role() NOT IN ('super_admin','knowledge_admin') THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF imp.imported_by = app.actor_id() THEN
  RAISE EXCEPTION 'Four eyes: the proposer cannot decide' USING ERRCODE='42501'; END IF;
 IF NOT approve THEN
  IF note IS NULL OR length(trim(note)) < 10 THEN RAISE EXCEPTION 'Rejection reason required' USING ERRCODE='23514'; END IF;
  UPDATE app.ta_imports SET state='rejected', decided_by=app.actor_id(), decided_at=now(), decision_note=trim(note) WHERE id=target;
  INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'ta.import_rejected',target);
  RETURN jsonb_build_object('state','rejected');
 END IF;
 PERFORM pg_advisory_xact_lock(719290, 1);
 FOR e IN SELECT value FROM jsonb_array_elements(imp.payload->'elements') LOOP
  existing := NULL;
  SELECT * INTO existing FROM app.ta_elements WHERE category_id=imp.category_id AND external_id=e->>'externalId' FOR UPDATE;
  IF existing.id IS NULL THEN
   INSERT INTO app.ta_elements(category_id,external_id,kind,name,hostname,ip_address,environment,location,os,os_version,status,owner_label,end_of_support,description,attributes,source,updated_by)
   VALUES(imp.category_id,e->>'externalId',e->>'kind',e->>'name',e->>'hostname',e->>'ipAddress',e->>'environment',e->>'location',e->>'os',e->>'osVersion',e->>'status',e->>'owner',(e->>'endOfSupport')::date,coalesce(e->>'description',''),coalesce(e->'attributes','{}'::jsonb),imp.format,app.actor_id())
   RETURNING id INTO rid;
   INSERT INTO app.ta_element_changes(element_id,import_id,change) VALUES(rid,imp.id,'created');
   created := created + 1;
  ELSE
   SELECT coalesce(jsonb_object_agg(k, jsonb_build_array(o, n)), '{}'::jsonb) INTO changed FROM (VALUES
     ('kind', to_jsonb(existing.kind), e->'kind'),
     ('name', to_jsonb(existing.name), e->'name'),
     ('hostname', to_jsonb(existing.hostname), e->'hostname'),
     ('ipAddress', to_jsonb(existing.ip_address), e->'ipAddress'),
     ('environment', to_jsonb(existing.environment), e->'environment'),
     ('location', to_jsonb(existing.location), e->'location'),
     ('os', to_jsonb(existing.os), e->'os'),
     ('osVersion', to_jsonb(existing.os_version), e->'osVersion'),
     ('status', to_jsonb(existing.status), e->'status'),
     ('owner', to_jsonb(existing.owner_label), e->'owner'),
     ('endOfSupport', to_jsonb(existing.end_of_support::text), e->'endOfSupport'),
     ('description', to_jsonb(existing.description), coalesce(e->'description','""'::jsonb)),
     ('attributes', existing.attributes, coalesce(e->'attributes','{}'::jsonb))
   ) AS f(k, o, n) WHERE coalesce(o,'null'::jsonb) IS DISTINCT FROM coalesce(n,'null'::jsonb);
   IF changed <> '{}'::jsonb THEN
    UPDATE app.ta_elements SET kind=e->>'kind',name=e->>'name',hostname=e->>'hostname',ip_address=e->>'ipAddress',environment=e->>'environment',location=e->>'location',os=e->>'os',os_version=e->>'osVersion',status=e->>'status',owner_label=e->>'owner',end_of_support=(e->>'endOfSupport')::date,description=coalesce(e->>'description',''),attributes=coalesce(e->'attributes','{}'::jsonb),source=imp.format,revision=revision+1,updated_at=now(),updated_by=app.actor_id()
    WHERE id=existing.id;
    INSERT INTO app.ta_element_changes(element_id,import_id,change,fields) VALUES(existing.id,imp.id,'updated',changed);
    updated := updated + 1;
   ELSE
    unchanged := unchanged + 1;
   END IF;
   rid := existing.id;
  END IF;
  ids := ids || rid;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(imp.payload->'relations') LOOP
  src := NULL; tgt := NULL; rid := NULL;
  SELECT id INTO src FROM app.ta_elements WHERE category_id=imp.category_id AND external_id=r->>'sourceExternalId';
  SELECT id INTO tgt FROM app.ta_elements WHERE category_id=imp.category_id AND external_id=r->>'targetExternalId';
  IF src IS NULL OR tgt IS NULL OR src = tgt THEN CONTINUE; END IF;
  INSERT INTO app.ta_relations(category_id,source_id,target_id,kind,external_id)
  VALUES(imp.category_id,src,tgt,r->>'kind',r->>'externalId')
  ON CONFLICT (source_id,target_id,kind) DO UPDATE SET external_id=excluded.external_id
  RETURNING id INTO rid;
  keep := keep || rid;
 END LOOP;
 DELETE FROM app.ta_relations WHERE category_id=imp.category_id AND source_id=ANY(ids) AND target_id=ANY(ids) AND NOT (id = ANY(keep));
 GET DIAGNOSTICS rel_removed = ROW_COUNT;
 SELECT count(*) INTO missing FROM app.ta_elements WHERE category_id=imp.category_id AND NOT (id = ANY(ids)) AND status <> 'retired';
 result_summary := imp.summary || jsonb_build_object('created',created,'updated',updated,'unchanged',unchanged,
  'relations',coalesce(cardinality(keep),0),'relationsRemoved',rel_removed,'notInImport',missing);
 UPDATE app.ta_imports SET state='applied', summary=result_summary, decided_by=app.actor_id(), decided_at=now(),
  decision_note=nullif(trim(coalesce(note,'')),'') WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'ta.imported',target);
 RETURN result_summary || jsonb_build_object('state','applied');
END $$;

-- One element's history for anyone who may read the element: what changed, from which
-- file, proposed and approved by whom. The import rows themselves stay admin-only.
CREATE FUNCTION app.ta_element_history(element uuid)
RETURNS TABLE(change text, fields jsonb, changed_at timestamptz, filename text, import_id uuid, proposed_by text, approved_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT ch.change, ch.fields, ch.changed_at, i.filename, i.id,
        (SELECT name FROM app.profiles p WHERE p.id=i.imported_by),
        (SELECT name FROM app.profiles p WHERE p.id=i.decided_by)
 FROM app.ta_element_changes ch
 JOIN app.ta_elements e ON e.id=ch.element_id
 JOIN app.ta_imports i ON i.id=ch.import_id
 WHERE ch.element_id=element AND app.in_category(e.category_id)
 ORDER BY ch.changed_at DESC, ch.id DESC LIMIT 50;
$$;

-- Pending proposals another admin can decide, for the sidebar badge.
CREATE FUNCTION app.ta_pending_for_actor() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT count(*)::int FROM app.ta_imports i
 WHERE i.state='pending' AND i.imported_by <> app.actor_id() AND app.in_category(i.category_id)
  AND app.actor_role() IN ('super_admin','knowledge_admin');
$$;

-- The worker's view of the model, for the search index only: every element, relation
-- and index entry. Nothing it returns is shown to a person.
CREATE FUNCTION app.ta_index_snapshot() RETURNS TABLE(elements jsonb, relations jsonb, entries jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT
  coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM app.ta_elements e), '[]'::jsonb),
  coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM app.ta_relations r), '[]'::jsonb),
  coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM app.ta_index_entries i), '[]'::jsonb);
$$;
CREATE FUNCTION app.ta_index_record(element uuid, knowledge text, card_sha text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 INSERT INTO app.ta_index_entries(element_id,knowledge_id,card_sha256) VALUES(element,knowledge,card_sha)
 ON CONFLICT (element_id) DO UPDATE SET knowledge_id=excluded.knowledge_id, card_sha256=excluded.card_sha256, synced_at=now();
$$;

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.ta_submit_import(uuid,jsonb,jsonb,text,text,text,text,jsonb) OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_withdraw_import(uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_decide_import(uuid,boolean,text) OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_pending_for_actor() OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_element_history(uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_index_snapshot() OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_index_record(uuid,text,text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.ta_submit_import(uuid,jsonb,jsonb,text,text,text,text,jsonb), app.ta_withdraw_import(uuid),
 app.ta_decide_import(uuid,boolean,text), app.ta_pending_for_actor(), app.ta_element_history(uuid), app.ta_index_snapshot(), app.ta_index_record(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ta_submit_import(uuid,jsonb,jsonb,text,text,text,text,jsonb), app.ta_withdraw_import(uuid),
 app.ta_decide_import(uuid,boolean,text), app.ta_pending_for_actor(), app.ta_element_history(uuid) TO intradocs_app;
GRANT EXECUTE ON FUNCTION app.ta_index_snapshot(), app.ta_index_record(uuid,text,text) TO intradocs_worker;
