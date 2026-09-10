CREATE TABLE app.labels (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),category_id uuid NOT NULL REFERENCES app.categories(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 32),color text NOT NULL DEFAULT 'blue' CHECK(color IN ('blue','green','amber','red','violet','grey')),
 revision integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX label_category_name_unique ON app.labels(category_id,lower(name));
INSERT INTO app.labels(category_id,name) SELECT DISTINCT d.category_id,label FROM app.documents d CROSS JOIN LATERAL unnest(d.labels) label WHERE length(trim(label)) BETWEEN 3 AND 32 ON CONFLICT DO NOTHING;
ALTER TABLE app.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.labels FORCE ROW LEVEL SECURITY;
CREATE POLICY labels_read ON app.labels FOR SELECT TO intradocs_app USING(app.in_category(category_id));
GRANT SELECT ON app.labels TO intradocs_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.labels,app.categories TO intradocs_workflow;
GRANT UPDATE(role,scope_all) ON app.profiles TO intradocs_workflow;
GRANT SELECT,INSERT,DELETE ON app.category_grants TO intradocs_workflow;

CREATE FUNCTION app.save_category(target uuid,expected_revision integer,parent uuid,name_value text,description_value text,minimum_value text,steps integer,days integer,position_value integer,confirm_tightening boolean) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE old app.categories; ancestors integer; descendants integer; new_id uuid; old_rank integer; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 IF app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.actor_active() THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF length(trim(name_value)) NOT BETWEEN 3 AND 100 OR length(description_value)>500 OR steps NOT IN (1,2) OR days NOT BETWEEN 1 AND 3650 OR position_value NOT BETWEEN 0 AND 10000 OR minimum_value NOT IN ('public','internal','restricted','confidential') THEN RAISE EXCEPTION 'Invalid taxonomy value' USING ERRCODE='23514'; END IF;
 IF parent IS NOT NULL AND NOT app.in_category(parent) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF parent IS NULL AND NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=app.actor_id() AND scope_all) THEN RAISE EXCEPTION 'Global category scope required' USING ERRCODE='42501'; END IF;
 IF target IS NOT NULL THEN
 SELECT * INTO old FROM app.categories WHERE id=target FOR UPDATE;
 IF old.id IS NULL OR NOT app.in_category(target) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF old.revision<>expected_revision THEN RAISE EXCEPTION 'Taxonomy changed' USING ERRCODE='40001'; END IF;
 -- Moving a populated branch changes grants. This release refuses it rather than
 -- publishing a partial impact preview that could expose protected document counts.
 IF old.parent_id IS DISTINCT FROM parent AND EXISTS(
 WITH RECURSIVE subtree AS (SELECT id FROM app.categories WHERE id=target UNION ALL SELECT c.id FROM app.categories c JOIN subtree s ON c.parent_id=s.id)
 SELECT 1 FROM app.documents d JOIN subtree s ON s.id=d.category_id) THEN RAISE EXCEPTION 'Moving populated categories requires a separate access review' USING ERRCODE='23514'; END IF;
 IF app.classification_rank(minimum_value)<app.classification_rank(old.minimum_classification) THEN RAISE EXCEPTION 'Classification floor cannot be lowered through this editor' USING ERRCODE='23514'; END IF;
 old_rank:=app.classification_rank(old.minimum_classification);
 IF (app.classification_rank(minimum_value)>old_rank OR steps>old.approval_steps) AND NOT confirm_tightening THEN RAISE EXCEPTION 'Explicit tightening confirmation required' USING ERRCODE='23514'; END IF;
 END IF;
 IF parent IS NOT NULL AND EXISTS(SELECT 1 FROM app.documents WHERE category_id=parent) THEN RAISE EXCEPTION 'A used leaf cannot become a parent' USING ERRCODE='23514'; END IF;
 IF target=parent OR EXISTS(
 WITH RECURSIVE subtree AS (SELECT id FROM app.categories WHERE id=target UNION ALL SELECT c.id FROM app.categories c JOIN subtree s ON c.parent_id=s.id)
 SELECT 1 FROM subtree WHERE id=parent) THEN RAISE EXCEPTION 'Category cycle rejected' USING ERRCODE='23514'; END IF;
 WITH RECURSIVE a AS (SELECT id,parent_id,1 AS depth FROM app.categories WHERE id=parent UNION ALL SELECT c.id,c.parent_id,a.depth+1 FROM app.categories c JOIN a ON c.id=a.parent_id WHERE a.depth<10)
 SELECT coalesce(max(depth),0) INTO ancestors FROM a;
 WITH RECURSIVE s AS (SELECT id,1 AS depth FROM app.categories WHERE id=target UNION ALL SELECT c.id,s.depth+1 FROM app.categories c JOIN s ON c.parent_id=s.id WHERE s.depth<10)
 SELECT coalesce(max(depth),1) INTO descendants FROM s;
 IF ancestors+descendants>3 THEN RAISE EXCEPTION 'At most three category levels' USING ERRCODE='23514'; END IF;
 IF target IS NULL THEN
 new_id:=public.gen_random_uuid();
 INSERT INTO app.categories(id,parent_id,name,description,minimum_classification,approval_steps,review_days,position) VALUES(new_id,parent,trim(name_value),description_value,minimum_value,steps,days,position_value);
 ELSE
 new_id:=target; UPDATE app.categories SET parent_id=parent,name=trim(name_value),description=description_value,minimum_classification=minimum_value,approval_steps=steps,review_days=days,position=position_value,revision=revision+1 WHERE id=target;
 END IF;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'taxonomy.changed',public.gen_random_uuid());
 RETURN new_id;
END $$;
CREATE FUNCTION app.delete_category(target uuid,expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 IF app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(target) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.categories WHERE id=target AND revision=expected_revision) THEN RAISE EXCEPTION 'Category changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM app.categories WHERE parent_id=target) OR EXISTS(SELECT 1 FROM app.documents WHERE category_id=target) OR EXISTS(SELECT 1 FROM app.document_versions WHERE category_id=target) OR EXISTS(SELECT 1 FROM app.labels WHERE category_id=target) OR EXISTS(SELECT 1 FROM app.upload_requests WHERE category_id=target) THEN RAISE EXCEPTION 'Category still has references' USING ERRCODE='23514'; END IF;
 DELETE FROM app.category_grants WHERE category_id=target;
 DELETE FROM app.categories WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'taxonomy.changed',public.gen_random_uuid());
END $$;
CREATE FUNCTION app.save_label(target uuid,expected_revision integer,category uuid,name_value text,color_value text,remove boolean) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE old app.labels; new_id uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 IF app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(category) THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF length(trim(name_value)) NOT BETWEEN 3 AND 32 OR color_value NOT IN ('blue','green','amber','red','violet','grey') THEN RAISE EXCEPTION 'Invalid label' USING ERRCODE='23514'; END IF;
 IF target IS NOT NULL THEN
 SELECT * INTO old FROM app.labels WHERE id=target AND category_id=category FOR UPDATE;
 IF old.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF old.revision<>expected_revision THEN RAISE EXCEPTION 'Label changed' USING ERRCODE='40001'; END IF;
 IF (remove OR old.name<>trim(name_value)) AND EXISTS(SELECT 1 FROM app.document_versions v WHERE v.category_id=category AND old.name=ANY(v.labels)) THEN RAISE EXCEPTION 'Used labels cannot be renamed/deleted; create a new label' USING ERRCODE='23514'; END IF;
 IF remove THEN DELETE FROM app.labels WHERE id=target; ELSE UPDATE app.labels SET name=trim(name_value),color=color_value,revision=revision+1 WHERE id=target; END IF;
 new_id:=target;
 ELSE
 IF remove THEN RAISE EXCEPTION 'Label unavailable' USING ERRCODE='P0002'; END IF;
 INSERT INTO app.labels(category_id,name,color) VALUES(category,trim(name_value),color_value) RETURNING id INTO new_id;
 END IF;
 INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'taxonomy.changed',public.gen_random_uuid());
 RETURN new_id;
END $$;
CREATE FUNCTION app.assign_user(target text,role_value text,all_scope boolean,categories uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE me app.profiles; subject app.profiles; cat uuid; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 SELECT * INTO me FROM app.profiles WHERE id=app.actor_id() AND active;
 SELECT * INTO subject FROM app.profiles WHERE id=target FOR UPDATE;
 IF me.id IS NULL OR subject.id IS NULL OR target=me.id OR me.role NOT IN ('super_admin','knowledge_admin') THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF role_value NOT IN ('super_admin','knowledge_admin','reviewer','contributor','viewer') OR cardinality(categories)>100 OR (all_scope AND cardinality(categories)>0) THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='23514'; END IF;
 IF me.role='knowledge_admin' AND (subject.unit<>me.unit OR subject.role IN ('super_admin','knowledge_admin') OR role_value IN ('super_admin','knowledge_admin') OR all_scope) THEN RAISE EXCEPTION 'Scope escalation rejected' USING ERRCODE='42501'; END IF;
 FOREACH cat IN ARRAY categories LOOP IF NOT app.in_category(cat) THEN RAISE EXCEPTION 'Category outside management scope' USING ERRCODE='42501'; END IF; END LOOP;
 UPDATE app.profiles SET role=role_value,scope_all=all_scope WHERE id=target;
 DELETE FROM app.category_grants WHERE user_id=target;
 INSERT INTO app.category_grants(user_id,category_id) SELECT target,x FROM unnest(categories) x ON CONFLICT DO NOTHING;
 INSERT INTO app.audit_events(actor_id,action,subject_user_id,request_id) VALUES(app.actor_id(),'user.assignment_changed',target,public.gen_random_uuid());
END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.save_category(uuid,integer,uuid,text,text,text,integer,integer,integer,boolean) OWNER TO intradocs_workflow;
ALTER FUNCTION app.delete_category(uuid,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.save_label(uuid,integer,uuid,text,text,boolean) OWNER TO intradocs_workflow;
ALTER FUNCTION app.assign_user(text,text,boolean,uuid[]) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.save_category(uuid,integer,uuid,text,text,text,integer,integer,integer,boolean),app.delete_category(uuid,integer),app.save_label(uuid,integer,uuid,text,text,boolean),app.assign_user(text,text,boolean,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.save_category(uuid,integer,uuid,text,text,text,integer,integer,integer,boolean),app.delete_category(uuid,integer),app.save_label(uuid,integer,uuid,text,text,boolean),app.assign_user(text,text,boolean,uuid[]) TO intradocs_app;
CREATE POLICY audit_feedback_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(actor_id=app.actor_id() AND action='document.feedback' AND document_id IS NOT NULL AND app.can_read_document(document_id));
