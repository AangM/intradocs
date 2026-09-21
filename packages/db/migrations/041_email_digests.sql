-- Email delivery of what the bell already shows. The notification row stays the source
-- of truth; email is a second channel that batches it. The worker never reads the table
-- directly: two SECURITY DEFINER functions hand it one person's unsent items at a time
-- and take the result back, so the worker role learns nothing beyond the digest it sends.
ALTER TABLE app.notifications ADD COLUMN emailed_at timestamptz;
ALTER TABLE app.notifications ADD COLUMN email_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX notifications_unemailed ON app.notifications(user_id,created_at) WHERE emailed_at IS NULL;
-- A person's choice, default on; the settings page flips it.
ALTER TABLE app.profiles ADD COLUMN email_notifications boolean NOT NULL DEFAULT true;
GRANT UPDATE(email_notifications) ON app.profiles TO intradocs_workflow;

-- One digest per person: their unsent notifications, oldest first, once the newest of
-- them is at least `settle` old (so a burst of events becomes one mail, not five).
-- Items already tried `max_attempts` times are given up on: marked as emailed with no
-- mail, so a permanently bouncing address does not keep the queue busy forever.
CREATE FUNCTION app.claim_email_digest(settle interval, max_attempts integer)
RETURNS TABLE(user_id text,email text,name text,items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 UPDATE app.notifications SET emailed_at=now() WHERE emailed_at IS NULL AND email_attempts>=max_attempts;
 RETURN QUERY
 WITH person AS (
   SELECT n.user_id AS uid FROM app.notifications n JOIN app.profiles p ON p.id=n.user_id
   WHERE n.emailed_at IS NULL AND p.active AND p.email_notifications
   GROUP BY n.user_id HAVING max(n.created_at)<=now()-settle
   ORDER BY min(n.created_at) LIMIT 1
 )
 SELECT p.id,p.email,p.name,
   (SELECT jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'title',v.title,'documentId',d.id,'slug',d.slug,'versionId',v.id,'createdAt',n.created_at) ORDER BY n.created_at)
    FROM app.notifications n JOIN app.document_versions v ON v.id=n.version_id JOIN app.documents d ON d.id=v.document_id
    WHERE n.user_id=p.id AND n.emailed_at IS NULL)
 FROM person JOIN app.profiles p ON p.id=person.uid;
END $$;
-- The outcome for the items of one digest: sent, or one more failed attempt.
CREATE FUNCTION app.settle_email_digest(ids uuid[], sent boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE n integer; BEGIN
 IF sent THEN UPDATE app.notifications SET emailed_at=now() WHERE id=ANY(ids) AND emailed_at IS NULL;
 ELSE UPDATE app.notifications SET email_attempts=email_attempts+1 WHERE id=ANY(ids) AND emailed_at IS NULL; END IF;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;
-- A person turning email off, or an address that was never going to be mailed
-- (MAIL_MODE=off), must not leave a backlog that lands the day mail is switched on:
-- anything older than `age` is retired unsent.
CREATE FUNCTION app.retire_stale_email(age interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE n integer; BEGIN
 UPDATE app.notifications SET emailed_at=now() WHERE emailed_at IS NULL AND created_at<now()-age;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.claim_email_digest(interval,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.settle_email_digest(uuid[],boolean) OWNER TO intradocs_workflow;
ALTER FUNCTION app.retire_stale_email(interval) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.claim_email_digest(interval,integer),app.settle_email_digest(uuid[],boolean),app.retire_stale_email(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_email_digest(interval,integer),app.settle_email_digest(uuid[],boolean),app.retire_stale_email(interval) TO intradocs_worker;
-- The settings page reads and writes the person's own switch.
CREATE FUNCTION app.set_email_notifications(value boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.profiles SET email_notifications=value WHERE id=app.actor_id() AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'No active profile' USING ERRCODE='42501'; END IF; END $$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.set_email_notifications(boolean) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.set_email_notifications(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_email_notifications(boolean) TO intradocs_app;
