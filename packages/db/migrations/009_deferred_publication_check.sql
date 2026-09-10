-- Deferred triggers run at COMMIT under the session identity, after the
-- security-definer publisher has returned. The worker intentionally cannot
-- SELECT business tables. Give ONLY this fixed invariant-check function the
-- read-only policy identity, rather than granting the worker table access.
ALTER FUNCTION app.check_publication_pointer() SECURITY DEFINER;
ALTER FUNCTION app.check_publication_pointer() SET search_path=pg_catalog,app;
GRANT CREATE ON SCHEMA app TO intradocs_policy;
ALTER FUNCTION app.check_publication_pointer() OWNER TO intradocs_policy;
REVOKE CREATE ON SCHEMA app FROM intradocs_policy;
REVOKE ALL ON FUNCTION app.check_publication_pointer() FROM PUBLIC;
-- Requeue previously approved jobs affected by the missing deferred-check
-- privilege. All hashes, current permissions, leases and approval checks still
-- apply. This migration never marks any version published or ready directly.
UPDATE app.publication_outbox o SET state='pending',attempts=0,available_at=now(),lease_until=NULL,error_code=NULL
WHERE o.state='dead' AND o.error_code='index_failed' AND EXISTS(
 SELECT 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
 WHERE v.id=o.version_id AND v.review_state='approved' AND NOT d.withdrawn
 AND (v.expires_at IS NULL OR v.expires_at>now())
);
