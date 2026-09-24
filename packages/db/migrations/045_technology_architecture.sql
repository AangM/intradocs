-- Technology Architecture (TOGAF technology layer): elements and relations imported from
-- Sparx EA, scoped to a category like documents are. Readers see the elements of the
-- categories they may read; only knowledge/super admins of a category import into it.
-- Imports upsert by the Sparx GUID and never delete an element: one that is missing from
-- a later export is reported, not removed, because the model may simply be split.

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
 summary jsonb NOT NULL,
 imported_by text NOT NULL REFERENCES app.profiles(id),
 imported_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE POLICY ta_elements_read ON app.ta_elements FOR SELECT TO intradocs_app USING (app.in_category(category_id));
CREATE POLICY ta_relations_read ON app.ta_relations FOR SELECT TO intradocs_app USING (app.in_category(category_id));
CREATE POLICY ta_imports_read ON app.ta_imports FOR SELECT TO intradocs_app
 USING (app.in_category(category_id) AND app.actor_role() IN ('super_admin','knowledge_admin'));
CREATE POLICY ta_index_read ON app.ta_index_entries FOR SELECT TO intradocs_app
 USING (EXISTS (SELECT 1 FROM app.ta_elements e WHERE e.id = element_id AND app.in_category(e.category_id)));
GRANT SELECT ON app.ta_elements, app.ta_relations, app.ta_imports, app.ta_index_entries TO intradocs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ta_elements, app.ta_relations, app.ta_imports, app.ta_index_entries TO intradocs_workflow;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed','rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained','document.rolled_back','access.requested','access.decided','rag.answer_helpful','rag.answer_unhelpful','user.invited','user.invitation_revoked','user.invitation_accepted','role.created','role.updated','role.archived','document.reaffirmed','document.archived_by_policy','audit.exported','ta.imported'));

-- One import, one transaction: check the caller, upsert elements by GUID, resolve and
-- upsert relations, drop the relations this model no longer draws between its own
-- elements, record the import and the audit row. `payload` is parseTaImport's output.
CREATE FUNCTION app.ta_apply_import(target_category uuid, payload jsonb, file_name text, file_format text, file_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE
 e jsonb; r jsonb; existing app.ta_elements;
 created integer := 0; updated integer := 0; unchanged integer := 0;
 rel_kept integer := 0; rel_removed integer := 0; missing integer := 0;
 src uuid; tgt uuid; rid uuid; ids uuid[] := '{}'; keep uuid[] := '{}'; summary jsonb;
BEGIN
 IF app.actor_role() IS NULL OR app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(target_category) THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='42501'; END IF;
 IF file_format NOT IN ('xmi','csv') OR file_sha !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(payload->'elements') IS DISTINCT FROM 'array' OR jsonb_typeof(payload->'relations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(payload->'elements') > 5000 OR jsonb_array_length(payload->'relations') > 20000 THEN
  RAISE EXCEPTION 'Payload invalid' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(719290, 1);
 FOR e IN SELECT value FROM jsonb_array_elements(payload->'elements') LOOP
  existing := NULL;
  SELECT * INTO existing FROM app.ta_elements WHERE category_id=target_category AND external_id=e->>'externalId' FOR UPDATE;
  IF existing.id IS NULL THEN
   INSERT INTO app.ta_elements(category_id,external_id,kind,name,hostname,ip_address,environment,location,os,os_version,status,owner_label,end_of_support,description,attributes,source,updated_by)
   VALUES(target_category,e->>'externalId',e->>'kind',e->>'name',e->>'hostname',e->>'ipAddress',e->>'environment',e->>'location',e->>'os',e->>'osVersion',e->>'status',e->>'owner',(e->>'endOfSupport')::date,coalesce(e->>'description',''),coalesce(e->'attributes','{}'::jsonb),file_format,app.actor_id())
   RETURNING id INTO rid;
   created := created + 1;
  ELSIF (existing.kind,existing.name,existing.hostname,existing.ip_address,existing.environment,existing.location,existing.os,existing.os_version,existing.status,existing.owner_label,existing.end_of_support,existing.description,existing.attributes)
     IS DISTINCT FROM (e->>'kind',e->>'name',e->>'hostname',e->>'ipAddress',e->>'environment',e->>'location',e->>'os',e->>'osVersion',e->>'status',e->>'owner',(e->>'endOfSupport')::date,coalesce(e->>'description',''),coalesce(e->'attributes','{}'::jsonb)) THEN
   UPDATE app.ta_elements SET kind=e->>'kind',name=e->>'name',hostname=e->>'hostname',ip_address=e->>'ipAddress',environment=e->>'environment',location=e->>'location',os=e->>'os',os_version=e->>'osVersion',status=e->>'status',owner_label=e->>'owner',end_of_support=(e->>'endOfSupport')::date,description=coalesce(e->>'description',''),attributes=coalesce(e->'attributes','{}'::jsonb),source=file_format,revision=revision+1,updated_at=now(),updated_by=app.actor_id()
   WHERE id=existing.id;
   rid := existing.id; updated := updated + 1;
  ELSE
   rid := existing.id; unchanged := unchanged + 1;
  END IF;
  ids := ids || rid;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(payload->'relations') LOOP
  src := NULL; tgt := NULL; rid := NULL;
  SELECT id INTO src FROM app.ta_elements WHERE category_id=target_category AND external_id=r->>'sourceExternalId';
  SELECT id INTO tgt FROM app.ta_elements WHERE category_id=target_category AND external_id=r->>'targetExternalId';
  IF src IS NULL OR tgt IS NULL OR src = tgt THEN CONTINUE; END IF;
  INSERT INTO app.ta_relations(category_id,source_id,target_id,kind,external_id)
  VALUES(target_category,src,tgt,r->>'kind',r->>'externalId')
  ON CONFLICT (source_id,target_id,kind) DO UPDATE SET external_id=excluded.external_id
  RETURNING id INTO rid;
  keep := keep || rid;
 END LOOP;
 rel_kept := coalesce(cardinality(keep), 0);
 DELETE FROM app.ta_relations WHERE category_id=target_category AND source_id=ANY(ids) AND target_id=ANY(ids) AND NOT (id = ANY(keep));
 GET DIAGNOSTICS rel_removed = ROW_COUNT;
 SELECT count(*) INTO missing FROM app.ta_elements WHERE category_id=target_category AND NOT (id = ANY(ids)) AND status <> 'retired';
 summary := jsonb_build_object('created',created,'updated',updated,'unchanged',unchanged,'relations',rel_kept,
  'relationsRemoved',rel_removed,'notInImport',missing,'skipped',coalesce(payload->'skipped','[]'::jsonb));
 INSERT INTO app.ta_imports(category_id,filename,format,sha256,summary,imported_by)
 VALUES(target_category,left(file_name,255),file_format,file_sha,summary,app.actor_id());
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'ta.imported',public.gen_random_uuid());
 RETURN summary;
END $$;

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
ALTER FUNCTION app.ta_apply_import(uuid,jsonb,text,text,text) OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_index_snapshot() OWNER TO intradocs_workflow;
ALTER FUNCTION app.ta_index_record(uuid,text,text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.ta_apply_import(uuid,jsonb,text,text,text), app.ta_index_snapshot(), app.ta_index_record(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ta_apply_import(uuid,jsonb,text,text,text) TO intradocs_app;
GRANT EXECUTE ON FUNCTION app.ta_index_snapshot(), app.ta_index_record(uuid,text,text) TO intradocs_worker;
