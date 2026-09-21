-- Reading the audit trail as a file is itself something an auditor wants to see in the
-- audit trail: who took a copy, and when. One more action, nothing else changes.
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed','rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained','document.rolled_back','access.requested','access.decided','rag.answer_helpful','rag.answer_unhelpful','user.invited','user.invitation_revoked','user.invitation_accepted','role.created','role.updated','role.archived','document.reaffirmed','document.archived_by_policy','audit.exported'));
-- The exporter writes that one row about itself: the roles that may read the trail
-- (super_admin and knowledge_admin hold audit.view), nothing attached to it.
CREATE POLICY audit_export_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND action='audit.exported'
 AND document_id IS NULL AND subject_user_id IS NULL
 AND app.actor_role() IN ('super_admin','knowledge_admin'));
