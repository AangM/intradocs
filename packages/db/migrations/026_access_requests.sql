-- S02/V1: ask for access without learning what you are missing.
--
-- The hard part is not the workflow, it is what the requester is allowed to name. A
-- viewer sees two of six categories and none of the documents outside their scope, so a
-- form that let them pick any category -- or worse, any document -- would turn the
-- request feature into a directory of everything they cannot read.
--
-- So a request names a CATEGORY the requester can already see, plus the classification
-- level they need within it. Nothing here reveals whether a document exists, how many
-- there are, or what they are called. Approval is a decision recorded for an admin to act
-- on; it grants nothing by itself, because access to restricted material is still issued
-- per document by its owner.
CREATE TABLE app.access_requests (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 requester_id text NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
 category_id uuid NOT NULL REFERENCES app.categories(id) ON DELETE CASCADE,
 classification text NOT NULL CHECK(classification IN ('restricted','confidential')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 20 AND 2000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','declined','cancelled')),
 decided_by text REFERENCES app.profiles(id),
 decided_at timestamptz,
 decision_note text CHECK(decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 5 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 -- One open request per person per category and level; repeats are not a way to nag.
 CONSTRAINT access_requests_decided CHECK((state='pending')=(decided_at IS NULL)));
CREATE UNIQUE INDEX access_requests_open_idx
 ON app.access_requests(requester_id,category_id,classification) WHERE state='pending';
CREATE INDEX access_requests_queue_idx ON app.access_requests(category_id,created_at DESC);

ALTER TABLE app.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.access_requests FORCE ROW LEVEL SECURITY;

-- You may raise a request only for a category you can already see, only about yourself,
-- and only at a level that actually needs a grant.
CREATE POLICY access_requests_insert ON app.access_requests FOR INSERT TO intradocs_app WITH CHECK(
 requester_id=app.actor_id() AND app.actor_active() AND app.in_category(category_id)
 AND state='pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL);

-- You see your own; taxonomy admins see the ones in categories they administer.
CREATE POLICY access_requests_read ON app.access_requests FOR SELECT TO intradocs_app USING(
 requester_id=app.actor_id()
 OR (app.actor_role() IN ('super_admin','knowledge_admin') AND app.in_category(category_id)));

-- A requester may withdraw their own; deciding goes through the function below.
CREATE POLICY access_requests_cancel ON app.access_requests FOR UPDATE TO intradocs_app
 USING(requester_id=app.actor_id() AND state='pending')
 WITH CHECK(requester_id=app.actor_id() AND state='cancelled');

GRANT SELECT,INSERT ON app.access_requests TO intradocs_app;
GRANT UPDATE(state,decided_at) ON app.access_requests TO intradocs_app;
GRANT SELECT,UPDATE ON app.access_requests TO intradocs_workflow;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained',
 'document.rolled_back','access.requested','access.decided'));

DROP POLICY audit_insert ON app.audit_events;
CREATE POLICY audit_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND (
 (action IN ('document.read','document.download') AND document_id IS NOT NULL AND app.can_read_document(document_id))
 OR (action IN ('user.activated','user.deactivated') AND app.actor_role()='super_admin' AND subject_user_id<>app.actor_id())
 OR (action IN ('rag.retrieval','rag.chat','rag.abstained')
     AND (document_id IS NULL OR app.can_read_document(document_id)))
 OR (action='rag.citation_rejected' AND document_id IS NULL AND subject_user_id IS NULL)
 -- An access request is about a category, never a document, so document_id stays null.
 OR (action='access.requested' AND document_id IS NULL AND subject_user_id IS NULL)));

/**
 * Records a decision on an access request.
 *
 * Approving does not hand out access: restricted material is still granted per document
 * by its owner through app.set_document_access. What this records is that an
 * administrator with scope over the category considered the request and answered it.
 */
CREATE FUNCTION app.decide_access_request(target uuid, approve boolean, note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.access_requests; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO r FROM app.access_requests WHERE id=target FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(r.category_id) THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF r.requester_id = app.actor_id() THEN
  RAISE EXCEPTION 'Cannot decide your own request' USING ERRCODE='23514'; END IF;
 IF r.state <> 'pending' THEN
  RAISE EXCEPTION 'Already decided' USING ERRCODE='40001'; END IF;
 IF note IS NULL OR length(btrim(note)) NOT BETWEEN 5 AND 2000 THEN
  RAISE EXCEPTION 'A reason is required either way' USING ERRCODE='23514'; END IF;
 UPDATE app.access_requests
 SET state=CASE WHEN approve THEN 'approved' ELSE 'declined' END,
     decided_by=app.actor_id(), decided_at=now(), decision_note=btrim(note)
 WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id)
 VALUES(app.actor_id(),'access.decided',r.requester_id,public.gen_random_uuid());
END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.decide_access_request(uuid,boolean,text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.decide_access_request(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_access_request(uuid,boolean,text) TO intradocs_app;
