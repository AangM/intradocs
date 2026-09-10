-- The worker role held CREATE on the database, so it could create arbitrary schemas.
-- tests/integration/governance.test.ts asserts it cannot; that assertion had never been
-- executed against a live database (docs/PLAN.md records PostgreSQL/RLS as NOT RUN), so
-- the gap stayed open. Verified before this migration: has_database_privilege(
-- 'intradocs_worker','intradocs','CREATE') = true, and the test created a real schema.
--
-- Nothing needs the privilege: migration 001 creates schema jobs AUTHORIZATION
-- intradocs_worker, and the worker starts pg-boss with createSchema:false, so queue
-- objects live in a schema the role already owns.
REVOKE CREATE ON DATABASE intradocs FROM intradocs_worker;
-- Same reasoning for the other runtime roles: none of them creates schemas at run time.
REVOKE CREATE ON DATABASE intradocs FROM intradocs_app, intradocs_auth;
DO $$ BEGIN
 IF has_database_privilege('intradocs_worker','intradocs','CREATE')
  OR has_database_privilege('intradocs_app','intradocs','CREATE') THEN
  RAISE EXCEPTION 'Runtime roles must not hold CREATE on the database';
 END IF;
END $$;
