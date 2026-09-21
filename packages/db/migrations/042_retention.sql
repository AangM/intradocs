-- Retention that runs itself. Until now the dates did two things on their own: an expired
-- version stopped being readable, and the owner got a reminder 14 days before a review
-- date. Everything after that was a person remembering. Three more things now happen
-- without one:
--   * an owner can confirm a document is still valid (reaffirm) instead of re-publishing
--     an unchanged version just to move the review date;
--   * a document that expired and was not replaced within a grace period is archived
--     (withdrawn) by policy, with the reason on record and the owner told;
--   * a review that is long overdue is escalated to the administrators of its category.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
 'review_assigned','review_decided','published','review_due','expired','feedback','index_failed',
 'archived','review_overdue'));
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN (
 'document.read','document.download','user.activated','user.deactivated','document.uploaded','upload.rejected','document.submitted','document.revised','review.approve','review.changes_requested','review.reject','review.finding_resolved','document.published','document.withdrawn','publication.retried','taxonomy.changed','document.feedback','user.assignment_changed','document.access_changed','rag.exported','rag.unindexed','rag.retrieval','rag.chat','rag.citation_rejected','rag.abstained','document.rolled_back','access.requested','access.decided','rag.answer_helpful','rag.answer_unhelpful','user.invited','user.invitation_revoked','user.invitation_accepted','role.created','role.updated','role.archived','document.reaffirmed','document.archived_by_policy'));

-- The owner says "still valid": the review date moves forward by the category's cadence
-- from today, the pending reminder is cleared, and the audit trail records who said so
-- and when. Only the current published version, only when the review is actually near
-- (30 days) or past -- a reaffirmation a year early would be a way to skip reviews.
CREATE FUNCTION app.reaffirm_version(target uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v app.document_versions; d app.documents; cadence integer; next_review timestamptz; BEGIN
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 SELECT * INTO v FROM app.document_versions WHERE id=target FOR UPDATE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO d FROM app.documents WHERE id=v.document_id;
 IF d.owner_id IS DISTINCT FROM app.actor_id() OR NOT app.can_read_document(d.id) OR app.actor_role()='viewer'
  THEN RAISE EXCEPTION 'Unavailable' USING ERRCODE='P0002'; END IF;
 IF d.withdrawn OR d.current_version_id IS DISTINCT FROM v.id OR v.review_state<>'approved' OR v.publication_state<>'published'
  THEN RAISE EXCEPTION 'Only the current published version can be reaffirmed' USING ERRCODE='23514'; END IF;
 IF v.expires_at IS NOT NULL AND v.expires_at<=now()
  THEN RAISE EXCEPTION 'An expired version needs a new version, not a reaffirmation' USING ERRCODE='23514'; END IF;
 IF v.review_at IS NULL OR v.review_at>now()+interval '30 days'
  THEN RAISE EXCEPTION 'Review is not due yet' USING ERRCODE='23514'; END IF;
 SELECT review_days INTO cadence FROM app.categories WHERE id=v.category_id;
 next_review:=now()+make_interval(days=>coalesce(cadence,180));
 -- Never past the expiry: the expiry is the hard stop the submitter chose.
 IF v.expires_at IS NOT NULL AND next_review>v.expires_at THEN next_review:=v.expires_at; END IF;
 UPDATE app.document_versions SET review_at=next_review WHERE id=v.id;
 UPDATE app.notifications SET read_at=coalesce(read_at,now()) WHERE version_id=v.id AND kind IN ('review_due','review_overdue') AND read_at IS NULL;
 INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.reaffirmed',d.id,public.gen_random_uuid());
 RETURN next_review;
END $$;

-- The hourly policy pass, run by the worker with the two windows it was configured with.
-- Archiving reuses exactly what a manual withdrawal does (documents.withdrawn, the
-- version's publication_state and reason, cancelled outbox rows and pending requests),
-- so every reader, the catalogue and the RAG reconciliation see one kind of withdrawal.
-- The audit row names the owner as actor with a distinct action: nobody clicked, and the
-- trail says so, but the document was theirs.
CREATE FUNCTION app.apply_retention(grace_days integer, overdue_days integer)
RETURNS TABLE(archived integer, escalated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r record; reason text; n_archived integer:=0; n_escalated integer:=0; BEGIN
 IF grace_days IS NULL OR grace_days<1 OR grace_days>3650 OR overdue_days IS NULL OR overdue_days<1 OR overdue_days>3650
  THEN RAISE EXCEPTION 'Retention windows invalid' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock_shared(719281,1);
 FOR r IN
  SELECT d.id AS document_id,d.owner_id,v.id AS version_id,v.expires_at
  FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id
  WHERE NOT d.withdrawn AND v.expires_at IS NOT NULL AND v.expires_at<=now()-make_interval(days=>grace_days)
   -- A replacement on its way (a draft or a version under review newer than the
   -- expired one) means the owner is already doing the work; leave it to them.
   AND NOT EXISTS(SELECT 1 FROM app.document_versions nv WHERE nv.document_id=d.id AND nv.created_at>v.created_at AND nv.review_state IN ('draft','in_review'))
  ORDER BY v.expires_at LIMIT 100
 LOOP
  reason:='Diarsipkan otomatis oleh kebijakan retensi: kedaluwarsa pada '||to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD')||' dan tidak diperbarui dalam masa tenggang '||grace_days||' hari.';
  UPDATE app.documents SET withdrawn=true WHERE id=r.document_id;
  UPDATE app.document_versions SET publication_state='withdrawn',withdrawal_reason=reason WHERE document_id=r.document_id AND publication_state='published';
  UPDATE app.publication_outbox SET state='cancelled' WHERE version_id IN(SELECT id FROM app.document_versions WHERE document_id=r.document_id) AND state IN ('pending','running','dead');
  UPDATE app.approval_requests SET state='cancelled',decided_at=now() WHERE document_id=r.document_id AND state='pending';
  INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(r.owner_id,'document.archived_by_policy',r.document_id,public.gen_random_uuid());
  INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(r.owner_id,r.version_id,'archived','archived:'||r.version_id) ON CONFLICT DO NOTHING;
  n_archived:=n_archived+1;
 END LOOP;
 -- Overdue reviews reach the category's administrators once per review date: a new
 -- date (a reaffirmation or a new version) is a new event, the same date is not.
 INSERT INTO app.notifications(user_id,version_id,kind,event_key)
 SELECT p.id,v.id,'review_overdue','overdue:'||v.id||':'||v.review_at::text
 FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id
 JOIN app.profiles p ON p.active AND p.role IN ('super_admin','knowledge_admin')
  AND (p.scope_all OR EXISTS(SELECT 1 FROM app.category_grants g WHERE g.user_id=p.id AND g.category_id=v.category_id))
 WHERE NOT d.withdrawn AND v.review_state='approved' AND v.publication_state='published'
  AND v.review_at<=now()-make_interval(days=>overdue_days)
  AND (v.expires_at IS NULL OR v.expires_at>now())
  AND NOT EXISTS(SELECT 1 FROM app.document_versions nv WHERE nv.document_id=d.id AND nv.created_at>v.created_at AND nv.review_state IN ('draft','in_review'))
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n_escalated=ROW_COUNT;
 archived:=n_archived; escalated:=n_escalated; RETURN NEXT;
END $$;

-- What the administrators' dashboard shows: the four retention states, in scope.
CREATE FUNCTION app.retention_overview(grace_days integer, overdue_days integer)
RETURNS TABLE(state text,document_id uuid,slug text,title text,owner_label text,category_name text,review_at timestamptz,expires_at timestamptz,due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT s.state,d.id,d.slug,v.title,o.name,c.name,v.review_at,v.expires_at,s.due_at
 FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id
 JOIN app.profiles o ON o.id=d.owner_id JOIN app.categories c ON c.id=v.category_id
 CROSS JOIN LATERAL (
  SELECT CASE
   WHEN v.expires_at IS NOT NULL AND v.expires_at<=now() THEN 'expired'
   WHEN v.review_at<=now()-make_interval(days=>overdue_days) THEN 'overdue'
   WHEN v.review_at<=now() THEN 'due'
   WHEN v.review_at<=now()+interval '14 days' THEN 'soon'
  END AS state,
  CASE WHEN v.expires_at IS NOT NULL AND v.expires_at<=now() THEN v.expires_at+make_interval(days=>grace_days) ELSE v.review_at END AS due_at
 ) s
 WHERE NOT d.withdrawn AND v.review_state='approved' AND v.publication_state='published' AND s.state IS NOT NULL
  AND app.in_category(v.category_id) AND app.actor_role() IN ('super_admin','knowledge_admin')
 ORDER BY s.due_at LIMIT 200;
$$;

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.reaffirm_version(uuid) OWNER TO intradocs_workflow;
ALTER FUNCTION app.apply_retention(integer,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.retention_overview(integer,integer) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.reaffirm_version(uuid),app.apply_retention(integer,integer),app.retention_overview(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reaffirm_version(uuid),app.retention_overview(integer,integer) TO intradocs_app;
GRANT EXECUTE ON FUNCTION app.apply_retention(integer,integer) TO intradocs_worker;
