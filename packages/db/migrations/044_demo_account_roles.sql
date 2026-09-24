-- The login page's demo-account list (DEMO_LOGIN only) needs each synthetic account's
-- role and whether it is active, before anyone is signed in -- so no actor, so RLS on
-- profiles hides them. This returns exactly that, and only for @example.test addresses:
-- a real account's role is never visible through it, whatever the caller passes.
CREATE FUNCTION app.demo_account_roles(emails text[])
RETURNS TABLE(email text, role text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.email, p.role, p.active FROM app.profiles p
 WHERE p.email = ANY(emails) AND p.email ~ '^[a-z0-9._-]+@example\.test$'
 LIMIT 50;
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.demo_account_roles(text[]) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.demo_account_roles(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.demo_account_roles(text[]) TO intradocs_app;
