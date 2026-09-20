-- Custom roles (S08). A custom role is a named profile on top of ONE built-in base role
-- that may only narrow it: it carries the base role's database ceiling unchanged (every
-- RLS policy keeps reading app.actor_role(), which still returns the base role) and a
-- list of capabilities the application refuses on every request. It never grants more
-- than its base. That keeps 41 policies untouched and the invariant "the database is
-- the authority on what a person can reach" intact; the application-level denial is
-- enforced in requireActor/requireApiActor, the single gate every page and route uses.
CREATE TABLE app.custom_roles (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 40),
 description text NOT NULL DEFAULT '' CHECK(length(description) <= 240),
 color text NOT NULL DEFAULT 'blue' CHECK(color IN ('blue','red','violet','green','amber','sky')),
 base_role text NOT NULL CHECK(base_role IN ('knowledge_admin','reviewer','contributor','viewer')),
 denied_capabilities text[] NOT NULL DEFAULT '{}'
  CHECK(denied_capabilities <@ ARRAY['documents.upload','documents.review','taxonomy.view','users.view','users.manage','audit.view','analytics.view']::text[]),
 revision integer NOT NULL DEFAULT 1,
 created_by text NOT NULL REFERENCES app.profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz
);
CREATE UNIQUE INDEX custom_roles_name_key ON app.custom_roles(lower(btrim(name))) WHERE archived_at IS NULL;
ALTER TABLE app.profiles ADD COLUMN custom_role_id uuid REFERENCES app.custom_roles(id);
ALTER TABLE app.invitations ADD COLUMN custom_role_id uuid REFERENCES app.custom_roles(id);
-- A profile's built-in role and its custom role's base can never disagree: the policies
-- read profiles.role, the application reads the custom role; both must describe one person.
CREATE FUNCTION app.custom_role_matches() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.custom_role_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.custom_roles r WHERE r.id=NEW.custom_role_id AND r.base_role=NEW.role AND r.archived_at IS NULL) THEN
  RAISE EXCEPTION 'Custom role does not match the base role' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER profiles_custom_role BEFORE INSERT OR UPDATE OF role,custom_role_id ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.custom_role_matches();
CREATE TRIGGER invitations_custom_role BEFORE INSERT OR UPDATE OF role,custom_role_id ON app.invitations FOR EACH ROW EXECUTE FUNCTION app.custom_role_matches();

ALTER TABLE app.custom_roles ENABLE ROW LEVEL SECURITY;
-- Anyone signed in may read role definitions (a name in a table is not a secret; the
-- capabilities are what the person already experiences). Writes go through functions.
CREATE POLICY custom_roles_read ON app.custom_roles FOR SELECT TO intradocs_app USING(app.actor_active());
GRANT SELECT ON app.custom_roles TO intradocs_app,intradocs_workflow,intradocs_policy;

/** Create or update a custom role. Super admin only: a role definition is account policy. */
CREATE FUNCTION app.save_custom_role(target uuid,expected_revision integer,name_value text,description_value text,color_value text,base text,denied text[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; existing app.custom_roles; created uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 IF me.id IS NULL OR me.role<>'super_admin' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF target IS NULL THEN
  INSERT INTO app.custom_roles(name,description,color,base_role,denied_capabilities,created_by)
   VALUES(btrim(name_value),coalesce(description_value,''),color_value,base,denied,me.id) RETURNING id INTO created;
  INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'role.created',public.gen_random_uuid());
  RETURN created;
 END IF;
 SELECT * INTO existing FROM app.custom_roles WHERE id=target AND archived_at IS NULL FOR UPDATE;
 IF existing.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF existing.revision<>expected_revision THEN RAISE EXCEPTION 'Revision conflict' USING ERRCODE='40001'; END IF;
 -- The base role is fixed once people hold the role: changing it would silently move
 -- every holder to a different database ceiling. Archive and create instead.
 IF existing.base_role<>base AND EXISTS(SELECT 1 FROM app.profiles p WHERE p.custom_role_id=target) THEN
  RAISE EXCEPTION 'Base role is fixed while the role is assigned' USING ERRCODE='23514'; END IF;
 UPDATE app.custom_roles SET name=btrim(name_value),description=coalesce(description_value,''),color=color_value,base_role=base,denied_capabilities=denied,revision=revision+1,updated_at=now() WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'role.updated',public.gen_random_uuid());
 RETURN target;
END $$;

/** Archive a custom role nobody holds any more. Holders must be reassigned first. */
CREATE FUNCTION app.archive_custom_role(target uuid,expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; existing app.custom_roles; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 IF me.id IS NULL OR me.role<>'super_admin' THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO existing FROM app.custom_roles WHERE id=target AND archived_at IS NULL FOR UPDATE;
 IF existing.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF existing.revision<>expected_revision THEN RAISE EXCEPTION 'Revision conflict' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM app.profiles p WHERE p.custom_role_id=target) OR EXISTS(SELECT 1 FROM app.invitations i WHERE i.custom_role_id=target AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()) THEN
  RAISE EXCEPTION 'Role still assigned' USING ERRCODE='23514'; END IF;
 UPDATE app.custom_roles SET archived_at=now(),revision=revision+1 WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'role.archived',public.gen_random_uuid());
END $$;

/** assign_user with a custom role: same authority rules as before, applied to the base role. */
CREATE FUNCTION app.assign_user(target text,role_value text,all_scope boolean,categories uuid[],custom_role uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; subject app.profiles; cr app.custom_roles; cat uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 SELECT * INTO subject FROM app.profiles WHERE id=target FOR UPDATE;
 IF me.id IS NULL OR subject.id IS NULL OR target=me.id OR me.role NOT IN ('super_admin','knowledge_admin') THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF role_value NOT IN ('super_admin','knowledge_admin','reviewer','contributor','viewer') OR cardinality(categories)>100 OR (all_scope AND cardinality(categories)>0) THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 IF custom_role IS NOT NULL THEN
  SELECT * INTO cr FROM app.custom_roles WHERE id=custom_role AND archived_at IS NULL;
  IF cr.id IS NULL OR cr.base_role<>role_value THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 END IF;
 IF me.role='knowledge_admin' AND (subject.unit<>me.unit OR subject.role IN ('super_admin','knowledge_admin') OR role_value IN ('super_admin','knowledge_admin') OR all_scope) THEN RAISE EXCEPTION 'Scope escalation rejected' USING ERRCODE='42501'; END IF;
 FOREACH cat IN ARRAY categories LOOP IF NOT app.in_category(cat) THEN RAISE EXCEPTION 'Category outside management scope' USING ERRCODE='42501'; END IF; END LOOP;
 UPDATE app.profiles SET role=role_value,scope_all=all_scope,custom_role_id=custom_role WHERE id=target;
 DELETE FROM app.category_grants WHERE user_id=target;
 INSERT INTO app.category_grants(user_id,category_id) SELECT target,x FROM unnest(categories) x ON CONFLICT DO NOTHING;
 INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id) VALUES(app.actor_id(),'user.assignment_changed',target,public.gen_random_uuid());
END $$;

/** create_invitation with a custom role; open/accept carry it into the new profile. */
CREATE FUNCTION app.create_invitation(hash text,mail text,full_name text,unit_name text,role_value text,all_scope boolean,categories uuid[],ttl interval,custom_role uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; cr app.custom_roles; cat uuid; created uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 IF me.id IS NULL OR me.role NOT IN ('super_admin','knowledge_admin') THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF role_value NOT IN ('knowledge_admin','reviewer','contributor','viewer') OR cardinality(categories)>100 OR (all_scope AND cardinality(categories)>0) THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 IF custom_role IS NOT NULL THEN
  SELECT * INTO cr FROM app.custom_roles WHERE id=custom_role AND archived_at IS NULL;
  IF cr.id IS NULL OR cr.base_role<>role_value THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 END IF;
 IF me.role='knowledge_admin' AND (unit_name<>me.unit OR role_value='knowledge_admin' OR all_scope) THEN RAISE EXCEPTION 'Scope escalation rejected' USING ERRCODE='42501'; END IF;
 FOREACH cat IN ARRAY categories LOOP IF NOT app.in_category(cat) THEN RAISE EXCEPTION 'Category outside management scope' USING ERRCODE='42501'; END IF; END LOOP;
 IF EXISTS(SELECT 1 FROM app.profiles p WHERE lower(p.email)=lower(mail)) THEN RAISE EXCEPTION 'Email already registered' USING ERRCODE='23505'; END IF;
 INSERT INTO app.invitations(token_hash,email,name,unit,role,scope_all,category_ids,invited_by,expires_at,custom_role_id)
  VALUES(hash,mail,btrim(full_name),btrim(unit_name),role_value,all_scope,categories,me.id,now()+ttl,custom_role) RETURNING id INTO created;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(me.id,'user.invited',public.gen_random_uuid());
 RETURN created;
END $$;
DROP FUNCTION app.open_invitation(text);
CREATE FUNCTION app.open_invitation(hash text) RETURNS TABLE(id uuid,email text,name text,unit text,role text,role_label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT i.id,i.email,i.name,i.unit,i.role,(SELECT r.name FROM app.custom_roles r WHERE r.id=i.custom_role_id)
 FROM app.invitations i WHERE i.token_hash=hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
$$;
CREATE OR REPLACE FUNCTION app.accept_invitation(hash text,new_user_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE inv app.invitations; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO inv FROM app.invitations WHERE token_hash=hash FOR UPDATE;
 IF inv.id IS NULL OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now() THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM app.profiles p WHERE lower(p.email)=lower(inv.email)) THEN RAISE EXCEPTION 'Email already registered' USING ERRCODE='23505'; END IF;
 -- An archived custom role falls back to its base role rather than blocking the person.
 INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all,custom_role_id) VALUES(new_user_id,inv.name,inv.email,inv.unit,inv.role,true,inv.scope_all,
  (SELECT r.id FROM app.custom_roles r WHERE r.id=inv.custom_role_id AND r.archived_at IS NULL));
 INSERT INTO app.category_grants(user_id,category_id) SELECT new_user_id,x FROM unnest(inv.category_ids) x ON CONFLICT DO NOTHING;
 UPDATE app.invitations SET accepted_at=now(),accepted_user_id=new_user_id WHERE id=inv.id;
 INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id) VALUES(inv.invited_by,'user.invitation_accepted',new_user_id,public.gen_random_uuid());
END $$;

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained',
 'document.rolled_back','access.requested','access.decided',
 'rag.answer_helpful','rag.answer_unhelpful',
 'user.invited','user.invitation_revoked','user.invitation_accepted',
 'role.created','role.updated','role.archived'));

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.custom_role_matches() OWNER TO intradocs_workflow;
ALTER FUNCTION app.save_custom_role(uuid,integer,text,text,text,text,text[]) OWNER TO intradocs_workflow;
ALTER FUNCTION app.archive_custom_role(uuid,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.assign_user(text,text,boolean,uuid[],uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.create_invitation(text,text,text,text,text,boolean,uuid[],interval,uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.open_invitation(text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.save_custom_role(uuid,integer,text,text,text,text,text[]),app.archive_custom_role(uuid,integer),app.assign_user(text,text,boolean,uuid[],uuid),app.create_invitation(text,text,text,text,text,boolean,uuid[],interval,uuid),app.open_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.save_custom_role(uuid,integer,text,text,text,text,text[]),app.archive_custom_role(uuid,integer),app.assign_user(text,text,boolean,uuid[],uuid),app.create_invitation(text,text,text,text,text,boolean,uuid[],interval,uuid),app.open_invitation(text) TO intradocs_app;
GRANT SELECT,INSERT,UPDATE ON app.custom_roles TO intradocs_workflow;
