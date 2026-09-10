-- Replaces the merge introduced in 024, which was wrong.
--
-- 024 rewrote document_versions.labels. The database refused it: app.protect_version()
-- freezes thirteen fields including `labels`, on every update, at every review state --
-- "Immutable version; create a revision". That is not an obstacle to work around. A
-- version snapshot is what a reviewer approved, and retroactively relabelling it would
-- change the record after the fact.
--
-- So merging becomes an alias rather than a rewrite. The source label stops being
-- offered for new documents and points at the target; historical versions keep the exact
-- string they were approved with; and filtering by the target also matches the merged
-- name, which is the outcome an admin actually wanted from "merge".
DROP FUNCTION IF EXISTS app.merge_labels(uuid,uuid,integer);

ALTER TABLE app.labels ADD COLUMN merged_into uuid REFERENCES app.labels(id),
 ADD CONSTRAINT labels_merge_not_self CHECK(merged_into IS NULL OR merged_into <> id);
CREATE INDEX labels_merged_into_idx ON app.labels(merged_into) WHERE merged_into IS NOT NULL;

CREATE FUNCTION app.merge_labels(source uuid, target uuid, expected_revision integer)
RETURNS TABLE(aliased_name text, merged_name text, affected_versions integer)
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
 IF dst.merged_into IS NOT NULL THEN
  RAISE EXCEPTION 'Target label is itself merged' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM app.labels WHERE merged_into=source) THEN
  -- One level only: chains would make "what does this label mean" depend on traversal.
  RAISE EXCEPTION 'Source already receives merges' USING ERRCODE='23514'; END IF;

 SELECT count(*)::integer INTO n FROM app.document_versions v
  WHERE v.category_id=src.category_id AND src.name=ANY(v.labels);
 UPDATE app.labels SET merged_into=target, revision=revision+1 WHERE id=source;
 INSERT INTO app.audit_events(actor_id,action,request_id)
 VALUES(app.actor_id(),'taxonomy.changed',public.gen_random_uuid());
 RETURN QUERY SELECT src.name, dst.name, n; END $$;

/**
 * Every name that should be treated as this label, including names merged into it.
 * Used by discovery so a filter on the surviving label still finds documents approved
 * under the old one -- without touching a single frozen snapshot.
 */
CREATE FUNCTION app.label_names(target uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT array_agg(name) FROM app.labels WHERE id=target OR merged_into=target
$$;

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.merge_labels(uuid,uuid,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.label_names(uuid) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.merge_labels(uuid,uuid,integer),app.label_names(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.merge_labels(uuid,uuid,integer),app.label_names(uuid) TO intradocs_app;
