-- S08/V1: local invitations -- "undang pengguna" without an identity provider.
--
-- There is no email here and no SSO. An invitation is a row an administrator creates
-- with the role and scope decided up front, plus a one-time token shown ONCE to that
-- administrator, who hands the link over however they like. Accepting the link is the
-- only moment the person types anything: a password, into their own new account. The
-- table stores a hash of the token, never the token; a used, expired or revoked row can
-- never be accepted again.
--
-- Authority mirrors app.assign_user(): a super admin may invite any non-super role
-- anywhere; a knowledge admin may invite viewers, contributors and reviewers into their
-- own unit and only with categories inside their own scope. Nobody creates a super
-- admin through this path -- that stays a deliberate database action.
CREATE TABLE app.invitations (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 email text NOT NULL CHECK(email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(email) <= 254),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 120),
 unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 2 AND 80),
 role text NOT NULL CHECK(role IN ('knowledge_admin','reviewer','contributor','viewer')),
 scope_all boolean NOT NULL DEFAULT false,
 category_ids uuid[] NOT NULL DEFAULT '{}',
 invited_by text NOT NULL REFERENCES app.profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 accepted_user_id text REFERENCES app.profiles(id),
 revoked_at timestamptz,
 CONSTRAINT invitations_scope CHECK(NOT (scope_all AND cardinality(category_ids) > 0)),
 CONSTRAINT invitations_accepted CHECK((accepted_at IS NULL) = (accepted_user_id IS NULL)));
-- One open invitation per address; a repeat means revoke and invite again.
CREATE UNIQUE INDEX invitations_open_email_idx ON app.invitations(lower(email))
 WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
-- Administrators see the invitations they may have issued: super admins all of them,
-- knowledge admins those of their own unit. Nobody else sees the table at all.
CREATE POLICY invitations_read ON app.invitations FOR SELECT TO intradocs_app USING(
 app.actor_active() AND (app.actor_role()='super_admin'
  OR (app.actor_role()='knowledge_admin'
      AND unit=(SELECT p.unit FROM app.profiles p WHERE p.id=app.actor_id()))));
GRANT SELECT ON app.invitations TO intradocs_app;
-- Writes go through the two functions below only.
GRANT SELECT,INSERT,UPDATE ON app.invitations TO intradocs_workflow;
GRANT INSERT ON app.profiles TO intradocs_workflow;
GRANT SELECT,INSERT ON app.audit_events TO intradocs_workflow;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained',
 'document.rolled_back','access.requested','access.decided',
 'rag.answer_helpful','rag.answer_unhelpful',
 'user.invited','user.invitation_revoked','user.invitation_accepted'));

/** Creates an invitation; returns its id. The caller supplies the token hash. */
CREATE FUNCTION app.create_invitation(hash text,mail text,full_name text,unit_name text,role_value text,all_scope boolean,categories uuid[],ttl interval)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; cat uuid; created uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 IF me.id IS NULL OR me.role NOT IN ('super_admin','knowledge_admin') THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF role_value NOT IN ('knowledge_admin','reviewer','contributor','viewer') OR cardinality(categories)>100 OR (all_scope AND cardinality(categories)>0) THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 IF me.role='knowledge_admin' AND (unit_name<>me.unit OR role_value='knowledge_admin' OR all_scope) THEN RAISE EXCEPTION 'Scope escalation rejected' USING ERRCODE='42501'; END IF;
 FOREACH cat IN ARRAY categories LOOP IF NOT app.in_category(cat) THEN RAISE EXCEPTION 'Category outside management scope' USING ERRCODE='42501'; END IF; END LOOP;
 IF EXISTS(SELECT 1 FROM app.profiles p WHERE lower(p.email)=lower(mail)) THEN RAISE EXCEPTION 'Email already registered' USING ERRCODE='23505'; END IF;
 INSERT INTO app.invitations(token_hash,email,name,unit,role,scope_all,category_ids,invited_by,expires_at)
  VALUES(hash,mail,btrim(full_name),btrim(unit_name),role_value,all_scope,categories,me.id,now()+ttl) RETURNING id INTO created;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'user.invited',public.gen_random_uuid());
 RETURN created;
END $$;

/** Revokes an open invitation the caller may see. */
CREATE FUNCTION app.revoke_invitation(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; inv app.invitations; BEGIN
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 SELECT * INTO inv FROM app.invitations WHERE id=target FOR UPDATE;
 IF me.id IS NULL OR inv.id IS NULL OR me.role NOT IN ('super_admin','knowledge_admin') OR (me.role='knowledge_admin' AND inv.unit<>me.unit) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL THEN RETURN; END IF;
 UPDATE app.invitations SET revoked_at=now() WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'user.invitation_revoked',public.gen_random_uuid());
END $$;

/**
 * Looks an open invitation up by token hash for the acceptance page. Returns nothing for
 * unknown, used, revoked or expired tokens alike; no actor is involved.
 */
CREATE FUNCTION app.open_invitation(hash text) RETURNS TABLE(id uuid,email text,name text,unit text,role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT i.id,i.email,i.name,i.unit,i.role FROM app.invitations i
 WHERE i.token_hash=hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
$$;

/**
 * Completes an invitation for an auth user the application has just created: the
 * profile, its grants, and the audit row naming the inviter as actor and the new person
 * as subject. Runs without an actor (nobody is signed in yet), so every check is here.
 */
CREATE FUNCTION app.accept_invitation(hash text,new_user_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE inv app.invitations; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO inv FROM app.invitations WHERE token_hash=hash FOR UPDATE;
 IF inv.id IS NULL OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now() THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM app.profiles p WHERE lower(p.email)=lower(inv.email)) THEN RAISE EXCEPTION 'Email already registered' USING ERRCODE='23505'; END IF;
 INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES(new_user_id,inv.name,inv.email,inv.unit,inv.role,true,inv.scope_all);
 INSERT INTO app.category_grants(user_id,category_id) SELECT new_user_id,x FROM unnest(inv.category_ids) x ON CONFLICT DO NOTHING;
 UPDATE app.invitations SET accepted_at=now(),accepted_user_id=new_user_id WHERE id=inv.id;
 INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id) VALUES(inv.invited_by,'user.invitation_accepted',new_user_id,public.gen_random_uuid());
END $$;

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.create_invitation(text,text,text,text,text,boolean,uuid[],interval) OWNER TO intradocs_workflow;
ALTER FUNCTION app.revoke_invitation(uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.open_invitation(text) OWNER TO intradocs_workflow;
ALTER FUNCTION app.accept_invitation(text,text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.create_invitation(text,text,text,text,text,boolean,uuid[],interval),app.revoke_invitation(uuid),app.open_invitation(text),app.accept_invitation(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_invitation(text,text,text,text,text,boolean,uuid[],interval),app.revoke_invitation(uuid),app.open_invitation(text),app.accept_invitation(text,text) TO intradocs_app;
