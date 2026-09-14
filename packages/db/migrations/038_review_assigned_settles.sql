-- A "you were assigned to review" notification is a call to act. Once the reviewer has
-- decided (or the request was cancelled by a newer revision) the call is over, yet the
-- row stayed unread and the bell kept counting it: Andi's badge said 6 with one item in
-- the queue. Now a decision, or a cancellation, marks the assignment notification read
-- for that reviewer and stage. Notifications the person still has to act on are untouched.
CREATE OR REPLACE FUNCTION app.notify_workflow() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE vid uuid; owner text; BEGIN
 IF TG_TABLE_NAME='approval_steps' THEN SELECT r.version_id,v.author_id INTO vid,owner FROM app.approval_requests r JOIN app.document_versions v ON v.id=r.version_id WHERE r.id=NEW.request_id;
 IF TG_OP='INSERT' THEN INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(NEW.reviewer_id,vid,'review_assigned','assigned:'||NEW.request_id||':'||NEW.stage) ON CONFLICT DO NOTHING;
 ELSIF NEW.decision IS NOT NULL AND OLD.decision IS NULL THEN
  INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,vid,'review_decided','decision:'||NEW.request_id||':'||NEW.stage) ON CONFLICT DO NOTHING;
  UPDATE app.notifications SET read_at=coalesce(read_at,now()) WHERE user_id=NEW.reviewer_id AND event_key='assigned:'||NEW.request_id||':'||NEW.stage;
 END IF;
 ELSIF TG_TABLE_NAME='approval_requests' THEN
  IF NEW.state<>'pending' AND OLD.state='pending' THEN
   UPDATE app.notifications n SET read_at=coalesce(n.read_at,now()) FROM app.approval_steps s WHERE s.request_id=NEW.id AND n.user_id=s.reviewer_id AND n.event_key='assigned:'||NEW.id||':'||s.stage;
  END IF;
 ELSIF TG_TABLE_NAME='publication_outbox' THEN IF NEW.state IN ('done','dead') AND OLD.state IS DISTINCT FROM NEW.state THEN SELECT author_id INTO owner FROM app.document_versions WHERE id=NEW.version_id;
 INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,NEW.version_id,CASE WHEN NEW.state='done' THEN 'published' ELSE 'index_failed' END,NEW.state||':'||NEW.id) ON CONFLICT DO NOTHING; END IF;
 ELSIF TG_TABLE_NAME='document_feedback' THEN SELECT d.owner_id INTO owner FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id WHERE v.id=NEW.version_id;
 INSERT INTO app.notifications(user_id,version_id,kind,event_key) VALUES(owner,NEW.version_id,'feedback','feedback:'||NEW.id) ON CONFLICT DO NOTHING; END IF; RETURN NEW; END $$;
CREATE TRIGGER notify_request AFTER UPDATE ON app.approval_requests FOR EACH ROW EXECUTE FUNCTION app.notify_workflow();
-- Assignments already settled before this migration.
UPDATE app.notifications n SET read_at=coalesce(n.read_at,now())
 FROM app.approval_steps s JOIN app.approval_requests r ON r.id=s.request_id
 WHERE n.kind='review_assigned' AND n.user_id=s.reviewer_id AND n.event_key='assigned:'||r.id||':'||s.stage
   AND (s.decision IS NOT NULL OR r.state<>'pending');
