-- The audit log is the one table that grows without bound and whose read policy called
-- app.can_read_document() once per row for a knowledge admin: at ~3,500 rows the
-- dashboard hit the 5 s statement timeout. The same rule expressed as a membership test
-- against an uncorrelated subquery is planned as a hashed SubPlan, so the readable
-- document set (a handful of rows) is computed once per statement instead of per event.
-- Who may read what does not change.
DROP POLICY audit_read ON app.audit_events;
CREATE POLICY audit_read ON app.audit_events FOR SELECT TO intradocs_app USING(
 app.actor_active() AND (
  app.actor_role()='super_admin'
  OR (app.actor_role()='knowledge_admin' AND (
   actor_id=app.actor_id()
   OR (document_id IS NOT NULL AND document_id IN (SELECT d.id FROM app.documents d WHERE app.can_read_document(d.id)))
  ))
  OR (app.actor_role()='reviewer' AND actor_id=app.actor_id())
 )
);
