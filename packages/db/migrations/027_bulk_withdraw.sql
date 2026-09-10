-- S03/V1: "aksi massal terbatas dengan konfirmasi dan audit".
--
-- Limited is the operative word. Bulk relabelling is impossible by design -- labels are
-- frozen on version snapshots -- and bulk category moves would change who can read what,
-- which is exactly the kind of decision that should stay one document at a time. What is
-- left, and what an owner actually needs, is withdrawing several documents at once when a
-- policy is superseded.
--
-- This is a wrapper, not a new path: each document goes through app.withdraw_document,
-- so ownership, scope, the reason requirement, outbox cancellation and the audit row are
-- all the ones that already existed. The wrapper adds a cap and all-or-nothing semantics:
-- either every document in the batch is withdrawn or none is, so a partial result never
-- leaves the caller guessing which half succeeded.
CREATE FUNCTION app.withdraw_documents(targets uuid[], reason text)
RETURNS TABLE(withdrawn integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t uuid; n integer:=0; BEGIN
 IF targets IS NULL OR cardinality(targets) = 0 THEN
  RAISE EXCEPTION 'Nothing selected' USING ERRCODE='23514'; END IF;
 -- A cap makes the blast radius of one mistaken click bounded and reviewable.
 IF cardinality(targets) > 25 THEN
  RAISE EXCEPTION 'At most 25 documents at a time' USING ERRCODE='23514'; END IF;
 IF cardinality(targets) <> cardinality(ARRAY(SELECT DISTINCT unnest(targets))) THEN
  RAISE EXCEPTION 'Duplicate selection' USING ERRCODE='23514'; END IF;
 FOREACH t IN ARRAY targets LOOP
  -- Any refusal raises, which rolls back the whole batch. Withdrawing is idempotent
  -- inside withdraw_document, so a document already withdrawn is not an error.
  PERFORM app.withdraw_document(t, reason);
  n := n + 1;
 END LOOP;
 RETURN QUERY SELECT n; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.withdraw_documents(uuid[],text) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.withdraw_documents(uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.withdraw_documents(uuid[],text) TO intradocs_app;
