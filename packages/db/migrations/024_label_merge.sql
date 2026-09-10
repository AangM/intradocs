-- S07/V1: merge two labels into one.
--
-- save_label already refuses to rename or delete a label that is in use, which is what
-- makes this a separate operation: consolidating "VPN" and "vpn" is exactly the case that
-- restriction blocks, and creating a third label does not clean anything up.
--
-- This does rewrite `labels` on versions that are already approved, so it is worth being
-- explicit about what that means. Submit freezes a version's content, classification and
-- review basis; none of those change here. Labels are discovery metadata that taxonomy
-- admins already own, and they take no part in access control -- category and
-- classification decide that, and both are untouched. What a reviewer saw as "vpn" may
-- afterwards read "VPN", so every merge writes an audit row naming the actor.
--
-- Scope is narrow on purpose: both labels must live in the same category, the actor needs
-- taxonomy authority over that category, and the merge cannot introduce a duplicate entry
-- into any version's array.
CREATE FUNCTION app.merge_labels(source uuid, target uuid, expected_revision integer)
RETURNS TABLE(versions_touched integer, merged_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE src app.labels; dst app.labels; n integer; BEGIN
 PERFORM pg_advisory_xact_lock(719281,1);
 IF source = target THEN RAISE EXCEPTION 'Pick two different labels' USING ERRCODE='23514'; END IF;
 SELECT * INTO src FROM app.labels WHERE id=source FOR UPDATE;
 SELECT * INTO dst FROM app.labels WHERE id=target FOR UPDATE;
 IF src.id IS NULL OR dst.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF src.category_id <> dst.category_id THEN
  RAISE EXCEPTION 'Labels belong to different categories' USING ERRCODE='23514'; END IF;
 IF app.actor_role() NOT IN ('super_admin','knowledge_admin') OR NOT app.in_category(src.category_id) THEN
  RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF src.revision <> expected_revision THEN
  RAISE EXCEPTION 'Label changed' USING ERRCODE='40001'; END IF;

 -- Replace the source name with the target name, without ever leaving a duplicate:
 -- a version already carrying both ends up with one entry, not two.
 UPDATE app.document_versions v
 SET labels = ARRAY(SELECT DISTINCT unnest(array_replace(v.labels, src.name, dst.name)))
 WHERE v.category_id = src.category_id AND src.name = ANY(v.labels);
 GET DIAGNOSTICS n = ROW_COUNT;
 -- documents.labels is a denormalised copy of the active version's labels; keep it in step.
 UPDATE app.documents d
 SET labels = ARRAY(SELECT DISTINCT unnest(array_replace(d.labels, src.name, dst.name)))
 WHERE d.category_id = src.category_id AND src.name = ANY(d.labels);

 DELETE FROM app.labels WHERE id=source;
 UPDATE app.labels SET revision=revision+1 WHERE id=target;
 INSERT INTO app.audit_events(actor_id,action,request_id)
 VALUES(app.actor_id(),'taxonomy.changed',public.gen_random_uuid());
 RETURN QUERY SELECT n, dst.name; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.merge_labels(uuid,uuid,integer) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.merge_labels(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.merge_labels(uuid,uuid,integer) TO intradocs_app;
