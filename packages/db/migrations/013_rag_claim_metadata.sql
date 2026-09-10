-- 010 returned only keys and hashes, but the exporter must build a provenance header
-- (title, version label, classification, category) and the worker role deliberately has
-- no SELECT on business tables. Widen the claim so the metadata travels with the lease
-- instead of granting the worker table access. RETURNS TABLE changes shape, so the
-- function is dropped and recreated rather than replaced.
DROP FUNCTION app.claim_rag_export();
CREATE FUNCTION app.claim_rag_export() RETURNS TABLE(
 job_id uuid,lease uuid,version uuid,document uuid,markdown_key text,markdown_hash text,
 operation text,knowledge_id text,document_title text,version_label text,classification text,category_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.rag_export_queue; token uuid; BEGIN
 UPDATE app.rag_export_queue SET state='dead',error_code='lease_exhausted'
  WHERE state='running' AND lease_until<now() AND attempts>=5;
 SELECT * INTO j FROM app.rag_export_queue q
  WHERE (q.state='pending' OR (q.state='running' AND q.lease_until<now()))
   AND q.available_at<=now() AND q.attempts<5
  ORDER BY q.available_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 token:=public.gen_random_uuid();
 UPDATE app.rag_export_queue SET state='running',attempts=attempts+1,lease_token=token,
  lease_until=now()+interval '120 seconds' WHERE id=j.id;
 -- A remove must stay claimable after its version row is gone from the indexable set,
 -- so metadata is read from the version itself and never re-checked for eligibility here;
 -- eligibility already decided the operation during reconciliation.
 RETURN QUERY SELECT j.id,token,v.id,v.document_id,v.markdown_key,v.markdown_sha256,j.operation,
  (SELECT e.knowledge_id FROM app.rag_index_entries e WHERE e.version_id=v.id),
  v.title,v.label,v.classification,coalesce(c.name,'-')
  FROM app.document_versions v LEFT JOIN app.categories c ON c.id=v.category_id
  WHERE v.id=j.version_id; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.claim_rag_export() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.claim_rag_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_rag_export() TO intradocs_worker;
