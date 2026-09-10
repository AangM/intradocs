-- 010 widened the audit CHECK for RAG actions but left the RLS insert policy untouched,
-- so the application role could not actually write them: every retrieval audit would have
-- failed with a policy violation. Adds the abstain action and lets the app role record
-- its own RAG events under the same actor/readability rules as document.read.
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained'));
DROP POLICY audit_insert ON app.audit_events;
CREATE POLICY audit_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND (
 (action IN ('document.read','document.download') AND document_id IS NOT NULL AND app.can_read_document(document_id))
 OR (action IN ('user.activated','user.deactivated') AND app.actor_role()='super_admin' AND subject_user_id<>app.actor_id())
 -- A cited document must still be readable at the moment it is recorded, so the audit
 -- trail cannot be used to confirm the existence of something out of scope.
 OR (action IN ('rag.retrieval','rag.chat','rag.abstained')
     AND (document_id IS NULL OR app.can_read_document(document_id)))
 -- A rejection is by definition about a source this actor may NOT have; recording which
 -- document it was would leak exactly what the rejection prevented.
 OR (action='rag.citation_rejected' AND document_id IS NULL AND subject_user_id IS NULL)
 ));
