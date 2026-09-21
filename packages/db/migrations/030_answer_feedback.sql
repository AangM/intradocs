-- S09/V1: "Membantu / tidak" on an assistant answer, and unanswered questions as gaps.
--
-- A vote is the reader's claim about one stored turn, kept on the turn (owner-only under
-- the policies of 029) and counted in the audit trail as two actions with no text
-- attached -- the dashboard reports how often answers helped, never what was asked.
--
-- A question the assistant could not answer is the same signal as a search that found
-- nothing, so it is recorded the way searches are: only the normalised form, only via
-- app.normalise_query (which drops anything that looks identifying), and reported by
-- app.knowledge_gaps only above its k-anonymity threshold. `source` says which surface
-- the signal came from, so the dashboard can label it.
ALTER TABLE app.ai_turns ADD COLUMN helpful boolean;
GRANT UPDATE(helpful) ON app.ai_turns TO intradocs_app;

ALTER TABLE app.search_events ADD COLUMN source text NOT NULL DEFAULT 'search'
 CHECK(source IN ('search','assistant_abstained','assistant_unhelpful'));

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded',
 'upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested',
 'review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried',
 'taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed',
 'rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained',
 'document.rolled_back','access.requested','access.decided',
 'rag.answer_helpful','rag.answer_unhelpful'));

DROP POLICY audit_insert ON app.audit_events;
CREATE POLICY audit_insert ON app.audit_events FOR INSERT TO intradocs_app WITH CHECK(
 actor_id=app.actor_id() AND app.actor_active() AND (
 (action IN ('document.read','document.download') AND document_id IS NOT NULL AND app.can_read_document(document_id))
 OR (action IN ('user.activated','user.deactivated') AND app.actor_role()='super_admin' AND subject_user_id<>app.actor_id())
 OR (action IN ('rag.retrieval','rag.chat','rag.abstained')
     AND (document_id IS NULL OR app.can_read_document(document_id)))
 OR (action='rag.citation_rejected' AND document_id IS NULL AND subject_user_id IS NULL)
 -- A vote is about a turn the actor owns; no document or person is named.
 OR (action IN ('rag.answer_helpful','rag.answer_unhelpful') AND document_id IS NULL AND subject_user_id IS NULL)
 -- An access request is about a category, never a document, so document_id stays null.
 OR (action='access.requested' AND document_id IS NULL AND subject_user_id IS NULL)));

-- The gap aggregate now spans two surfaces. Same k-anonymity, same normalisation; one
-- extra count says how many of the signals came from the assistant, so the dashboard
-- can label a gap "juga ditanyakan ke asisten" without exposing anything more.
DROP FUNCTION app.knowledge_gaps(integer,text,integer);
CREATE FUNCTION app.knowledge_gaps(days integer, unit text DEFAULT NULL, min_actors integer DEFAULT 3)
RETURNS TABLE(term text, searches bigint, people bigint, last_seen timestamptz, from_assistant bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT s.query_norm,count(*),count(DISTINCT s.actor_id),max(s.created_at),
        count(*) FILTER(WHERE s.source<>'search')
 FROM app.search_events s
 WHERE s.query_norm IS NOT NULL AND s.result_count=0
  AND s.created_at >= now()-make_interval(days=>greatest(1,least(365,days)))
  AND (unit IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=s.actor_id AND p.unit=unit))
 GROUP BY s.query_norm
 HAVING count(DISTINCT s.actor_id) >= greatest(3,min_actors)
 ORDER BY count(*) DESC, max(s.created_at) DESC
 LIMIT 20
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.knowledge_gaps(integer,text,integer) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.knowledge_gaps(integer,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.knowledge_gaps(integer,text,integer) TO intradocs_app;
