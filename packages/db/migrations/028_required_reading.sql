-- S06/V1: "bacaan wajib".
--
-- Marking a document as required reading is an instruction to people, so the design
-- question is who it can be aimed at. A requirement pointed at someone who cannot read
-- the document would tell them it exists and then refuse to show it -- an access leak
-- dressed up as a task. So a requirement targets a CATEGORY, and reaches exactly the
-- people who already have scope over it; nobody learns about a document from being asked
-- to read it.
--
-- Acknowledgement is a claim by the reader, not proof of understanding. It is stored as
-- what it is: a timestamp saying this person pressed the button.
CREATE TABLE app.reading_requirements (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 document_id uuid NOT NULL REFERENCES app.documents(id) ON DELETE CASCADE,
 category_id uuid NOT NULL REFERENCES app.categories(id) ON DELETE CASCADE,
 created_by text NOT NULL REFERENCES app.profiles(id),
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 10 AND 500),
 due_at timestamptz,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,category_id));
CREATE INDEX reading_requirements_category_idx ON app.reading_requirements(category_id) WHERE active;

CREATE TABLE app.reading_acknowledgements (
 requirement_id uuid NOT NULL REFERENCES app.reading_requirements(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES app.document_versions(id),
 acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(requirement_id,user_id));

ALTER TABLE app.reading_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reading_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE app.reading_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reading_acknowledgements FORCE ROW LEVEL SECURITY;

-- A requirement is visible only to people who can read the document it points at. That
-- is the whole leak-prevention argument: no readable document, no visible requirement.
CREATE POLICY reading_requirements_read ON app.reading_requirements FOR SELECT TO intradocs_app
 USING(active AND app.can_read_document(document_id) AND app.in_category(category_id));

-- Only a taxonomy admin with scope may create one, and only for a document they can read
-- in a category they administer.
CREATE POLICY reading_requirements_insert ON app.reading_requirements FOR INSERT TO intradocs_app
 WITH CHECK(created_by=app.actor_id() AND app.actor_active()
  AND app.actor_role() IN ('super_admin','knowledge_admin')
  AND app.in_category(category_id) AND app.can_read_document(document_id) AND active);

CREATE POLICY reading_requirements_retire ON app.reading_requirements FOR UPDATE TO intradocs_app
 USING(app.actor_role() IN ('super_admin','knowledge_admin') AND app.in_category(category_id))
 WITH CHECK(app.actor_role() IN ('super_admin','knowledge_admin') AND app.in_category(category_id));

-- You may record your own acknowledgement, for a requirement you can see, naming the
-- version you actually read. Admins with scope may read the roster.
CREATE POLICY reading_ack_insert ON app.reading_acknowledgements FOR INSERT TO intradocs_app
 WITH CHECK(user_id=app.actor_id() AND app.actor_active()
  AND EXISTS(SELECT 1 FROM app.reading_requirements r WHERE r.id=requirement_id)
  AND app.is_active_version(version_id));
CREATE POLICY reading_ack_read ON app.reading_acknowledgements FOR SELECT TO intradocs_app
 USING(user_id=app.actor_id()
  OR EXISTS(SELECT 1 FROM app.reading_requirements r WHERE r.id=requirement_id
   AND app.actor_role() IN ('super_admin','knowledge_admin') AND app.in_category(r.category_id)));

GRANT SELECT,INSERT ON app.reading_requirements TO intradocs_app;
GRANT UPDATE(active) ON app.reading_requirements TO intradocs_app;
GRANT SELECT,INSERT ON app.reading_acknowledgements TO intradocs_app;
GRANT SELECT ON app.reading_requirements,app.reading_acknowledgements TO intradocs_workflow;
