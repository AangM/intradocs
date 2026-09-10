-- Executed by the isolated local migration role; NEVER by the application role.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS jobs AUTHORIZATION intradocs_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA auth, app, jobs FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO intradocs_auth;
GRANT USAGE ON SCHEMA app TO intradocs_app, intradocs_policy, intradocs_worker;

CREATE TABLE auth."user" (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth.session (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON auth.session("userId");
CREATE TABLE auth.account (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(),
 "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("providerId","accountId")
);
CREATE INDEX account_user_idx ON auth.account("userId");
CREATE TABLE auth.verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth.verification(identifier);
CREATE TABLE auth."rateLimit" (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL DEFAULT 0, "lastRequest" bigint NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO intradocs_auth;
ALTER ROLE intradocs_auth SET search_path = auth, pg_catalog;

CREATE TABLE app.profiles (
 id text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE CASCADE,
 name text NOT NULL, email text NOT NULL, unit text NOT NULL,
 role text NOT NULL CHECK(role IN ('super_admin','knowledge_admin','reviewer','contributor','viewer')),
 active boolean NOT NULL DEFAULT true, scope_all boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.categories (
 id uuid PRIMARY KEY, parent_id uuid REFERENCES app.categories(id), name text NOT NULL,
 description text NOT NULL DEFAULT '', icon text NOT NULL DEFAULT 'folder', color text NOT NULL DEFAULT 'blue',
 position integer NOT NULL DEFAULT 0, CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE app.category_grants (
 user_id text REFERENCES app.profiles(id) ON DELETE CASCADE,
 category_id uuid REFERENCES app.categories(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,category_id)
);
CREATE TABLE app.documents (
 id uuid PRIMARY KEY, slug text NOT NULL, title text NOT NULL, summary text NOT NULL DEFAULT '',
 category_id uuid NOT NULL REFERENCES app.categories(id), owner_id text NOT NULL REFERENCES app.profiles(id),
 owner_label text NOT NULL, classification text NOT NULL CHECK(classification IN ('public','internal','restricted','confidential')),
 labels text[] NOT NULL DEFAULT '{}', current_version_id uuid, withdrawn boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.document_versions (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES app.documents(id), label text NOT NULL,
 review_state text NOT NULL CHECK(review_state IN ('draft','in_review','changes_requested','rejected','approved')),
 markdown_key text NOT NULL UNIQUE, markdown_sha256 text NOT NULL CHECK(markdown_sha256 ~ '^[0-9a-f]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size>=0), source_format text NOT NULL DEFAULT 'MD',
 approved_by text REFERENCES app.profiles(id), approved_by_label text, approved_at timestamptz,
 review_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,id), UNIQUE(document_id,label),
 CHECK(review_state <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
ALTER TABLE app.documents ADD CONSTRAINT current_version_same_document_fk
 FOREIGN KEY(id,current_version_id) REFERENCES app.document_versions(document_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE app.document_grants (
 document_id uuid REFERENCES app.documents(id) ON DELETE CASCADE, user_id text REFERENCES app.profiles(id) ON DELETE CASCADE,
 PRIMARY KEY(document_id,user_id)
);
CREATE TABLE app.review_assignments (
 document_id uuid REFERENCES app.documents(id) ON DELETE CASCADE, user_id text REFERENCES app.profiles(id) ON DELETE CASCADE,
 PRIMARY KEY(document_id,user_id)
);
CREATE TABLE app.audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id text NOT NULL REFERENCES app.profiles(id),
 action text NOT NULL CHECK(action IN ('document.read','document.download','user.activated','user.deactivated')),
 document_id uuid REFERENCES app.documents(id), subject_user_id text REFERENCES app.profiles(id),
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.worker_status (name text PRIMARY KEY CHECK(name='intradocs-worker'), last_seen timestamptz NOT NULL);
CREATE INDEX documents_category_idx ON app.documents(category_id);
CREATE INDEX documents_owner_idx ON app.documents(owner_id);
CREATE INDEX versions_document_idx ON app.document_versions(document_id,created_at DESC);
CREATE INDEX audit_actor_idx ON app.audit_events(actor_id,created_at DESC);
CREATE INDEX document_grants_user_idx ON app.document_grants(user_id,document_id);

-- The NOLOGIN policy role can only read the tables needed for fixed boolean predicates.
-- It avoids recursive RLS. No caller-controlled SQL or table names enter these functions.
GRANT SELECT ON app.profiles,app.categories,app.category_grants,app.documents,app.document_versions,app.document_grants,app.review_assignments TO intradocs_policy;
CREATE FUNCTION app.actor_id() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('app.actor_id',true),'')
$$;
CREATE FUNCTION app.actor_active() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.profiles WHERE id=app.actor_id() AND active)
$$;
CREATE FUNCTION app.actor_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT role FROM app.profiles WHERE id=app.actor_id() AND active
$$;
CREATE FUNCTION app.in_category(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND (
  EXISTS(SELECT 1 FROM app.profiles WHERE id=app.actor_id() AND scope_all)
  OR EXISTS(
   WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,ARRAY[id] AS visited FROM app.categories WHERE id=target
    UNION ALL
    SELECT c.id,c.parent_id,a.visited||c.id FROM app.categories c JOIN ancestors a ON c.id=a.parent_id
     WHERE NOT(c.id=ANY(a.visited)) AND cardinality(a.visited)<10
   ) SELECT 1 FROM ancestors a JOIN app.category_grants g ON g.category_id=a.id WHERE g.user_id=app.actor_id()
  )
 )
$$;
CREATE FUNCTION app.private_document_access(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.documents WHERE id=target AND owner_id=app.actor_id())
 OR EXISTS(SELECT 1 FROM app.review_assignments WHERE document_id=target AND user_id=app.actor_id())
$$;
CREATE FUNCTION app.can_read_document(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.actor_active() AND EXISTS(
  SELECT 1 FROM app.documents d WHERE d.id=target AND app.in_category(d.category_id)
  AND (d.classification IN ('public','internal') OR (
   app.actor_role()<>'viewer' AND EXISTS(SELECT 1 FROM app.document_grants g WHERE g.document_id=d.id AND g.user_id=app.actor_id())
  ))
  AND ((NOT d.withdrawn AND EXISTS(SELECT 1 FROM app.document_versions pv WHERE pv.id=d.current_version_id AND pv.review_state='approved')) OR app.private_document_access(d.id))
 )
$$;
CREATE FUNCTION app.can_read_version(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_versions v WHERE v.id=target AND app.can_read_document(v.document_id)
 AND (v.review_state='approved' OR app.private_document_access(v.document_id)))
$$;
CREATE FUNCTION app.can_view_profile(target text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT target=app.actor_id() OR (app.actor_active() AND (
 app.actor_role()='super_admin' OR (app.actor_role()='knowledge_admin' AND EXISTS(
 SELECT 1 FROM app.profiles p JOIN app.profiles me ON me.id=app.actor_id() WHERE p.id=target AND p.unit=me.unit
 ))))
$$;
-- Freeze content once submitted; migrations/seeds create new immutable rows instead of editing them.
CREATE FUNCTION app.protect_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF OLD.review_state<>'draft' AND (NEW.markdown_key IS DISTINCT FROM OLD.markdown_key OR NEW.markdown_sha256 IS DISTINCT FROM OLD.markdown_sha256 OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
  RAISE EXCEPTION 'Submitted content is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_version BEFORE UPDATE ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.protect_version();


CREATE FUNCTION app.check_publication_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.current_version_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM app.document_versions v WHERE v.id=NEW.current_version_id
  AND v.document_id=NEW.id AND v.review_state='approved' AND v.approved_by<>NEW.owner_id
 ) THEN RAISE EXCEPTION 'Publication requires an approved version of this document, not approved by its author'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publication_pointer_guard AFTER INSERT OR UPDATE ON app.documents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_publication_pointer();

-- Make ownership explicit, and do not leave predicates executable by PUBLIC.
GRANT CREATE ON SCHEMA app TO intradocs_policy;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.prosecdef LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO intradocs_policy',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app FROM intradocs_policy;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_id(),app.actor_active(),app.actor_role(),app.in_category(uuid),app.private_document_access(uuid),app.can_read_document(uuid),app.can_read_version(uuid),app.can_view_profile(text) TO intradocs_app,intradocs_policy;

ALTER TABLE app.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY profiles_read ON app.profiles FOR SELECT TO intradocs_app USING(app.can_view_profile(id));
CREATE POLICY profiles_update ON app.profiles FOR UPDATE TO intradocs_app USING(app.actor_role()='super_admin' AND id<>app.actor_id()) WITH CHECK(app.actor_role()='super_admin' AND id<>app.actor_id());
ALTER TABLE app.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.categories FORCE ROW LEVEL SECURITY;
CREATE POLICY categories_read ON app.categories FOR SELECT TO intradocs_app USING(app.in_category(id));
ALTER TABLE app.category_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.category_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY category_grants_read ON app.category_grants FOR SELECT TO intradocs_app USING(app.can_view_profile(user_id));
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_read ON app.documents FOR SELECT TO intradocs_app USING(app.can_read_document(id));
ALTER TABLE app.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY versions_read ON app.document_versions FOR SELECT TO intradocs_app USING(app.can_read_version(id));
ALTER TABLE app.document_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY document_grants_read ON app.document_grants FOR SELECT TO intradocs_app USING(app.can_view_profile(user_id) AND app.can_read_document(document_id));
ALTER TABLE app.review_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.review_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY review_assignment_read ON app.review_assignments FOR SELECT TO intradocs_app USING(app.can_view_profile(user_id) AND app.can_read_document(document_id));
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON app.audit_events FOR SELECT TO intradocs_app USING(
 app.actor_active() AND (app.actor_role()='super_admin' OR (app.actor_role()='knowledge_admin' AND (actor_id=app.actor_id() OR (document_id IS NOT NULL AND app.can_read_document(document_id)))) OR (app.actor_role()='reviewer' AND actor_id=app.actor_id()))
);
CREATE POLICY audit_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND (
 (action IN ('document.read','document.download') AND document_id IS NOT NULL AND app.can_read_document(document_id))
 OR (action IN ('user.activated','user.deactivated') AND app.actor_role()='super_admin' AND subject_user_id<>app.actor_id())
 )
);
ALTER TABLE app.worker_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.worker_status FORCE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_read ON app.worker_status FOR SELECT TO intradocs_app USING(app.actor_active());
CREATE POLICY heartbeat_write ON app.worker_status FOR ALL TO intradocs_worker USING(name='intradocs-worker') WITH CHECK(name='intradocs-worker');
GRANT SELECT ON app.profiles,app.categories,app.category_grants,app.documents,app.document_versions,app.document_grants,app.review_assignments,app.audit_events,app.worker_status TO intradocs_app;
GRANT UPDATE(active) ON app.profiles TO intradocs_app;
GRANT INSERT ON app.audit_events TO intradocs_app;
GRANT USAGE ON SEQUENCE app.audit_events_id_seq TO intradocs_app;
GRANT SELECT,INSERT,UPDATE ON app.worker_status TO intradocs_worker;
