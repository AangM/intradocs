-- S09/V1: conversation history for the assistant, kept on the IntraDocs side.
--
-- WeKnora sessions are still created and deleted per turn (see apps/web/src/lib/rag.ts):
-- nothing about a user, their access or their earlier questions ever accumulates there.
-- What people expect from "history" -- reopening yesterday's question and the sources it
-- came with -- is served from these tables, under the same row-level policies as the
-- rest of the portal.
--
-- Two rules keep history from becoming a side door:
--   1. A conversation is readable by its owner only. Admins do not see other people's
--      questions; the audit trail already records that a retrieval happened.
--   2. A stored citation is visible only while its version is still readable by the
--      owner (app.can_read_version). Revoke access and the snippet disappears from the
--      old answer too; the application hides the answer text with it, since the text
--      was composed from that snippet.
CREATE TABLE app.ai_conversations (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 user_id text NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ai_conversations_recent_idx ON app.ai_conversations(user_id,updated_at DESC);

CREATE TABLE app.ai_turns (
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id) ON DELETE CASCADE,
 question text NOT NULL CHECK(length(question) BETWEEN 1 AND 4000),
 answer text NOT NULL DEFAULT '' CHECK(length(answer) <= 20000),
 abstained boolean NOT NULL,
 mode text NOT NULL CHECK(mode IN ('generated','evidence-only')),
 -- The scope as asked: 'all', or a category / document list. Stored for display only;
 -- every new turn re-derives its scope from the database.
 scope jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb,
 scope_size integer NOT NULL CHECK(scope_size >= 0),
 rejected_count integer NOT NULL DEFAULT 0 CHECK(rejected_count >= 0),
 -- How many citations the turn was stored with. Compared with how many the reader can
 -- still see, so a revoked source is reported as hidden rather than silently gone.
 citation_count integer NOT NULL DEFAULT 0 CHECK(citation_count BETWEEN 0 AND 20),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ai_turns_conversation_idx ON app.ai_turns(conversation_id,created_at);

CREATE TABLE app.ai_turn_citations (
 turn_id uuid NOT NULL REFERENCES app.ai_turns(id) ON DELETE CASCADE,
 position smallint NOT NULL CHECK(position BETWEEN 1 AND 20),
 document_id uuid NOT NULL REFERENCES app.documents(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES app.document_versions(id) ON DELETE CASCADE,
 snippet text NOT NULL CHECK(length(snippet) <= 4000),
 heading text CHECK(heading IS NULL OR length(heading) <= 300),
 anchor text CHECK(anchor IS NULL OR length(anchor) <= 300),
 PRIMARY KEY(turn_id,position));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_conversations','ai_turns','ai_turn_citations'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;

CREATE POLICY ai_conversations_own ON app.ai_conversations FOR ALL TO intradocs_app
 USING(user_id=app.actor_id() AND app.actor_active())
 WITH CHECK(user_id=app.actor_id() AND app.actor_active());

CREATE POLICY ai_turns_own ON app.ai_turns FOR ALL TO intradocs_app
 USING(EXISTS(SELECT 1 FROM app.ai_conversations c WHERE c.id=conversation_id AND c.user_id=app.actor_id() AND app.actor_active()))
 WITH CHECK(EXISTS(SELECT 1 FROM app.ai_conversations c WHERE c.id=conversation_id AND c.user_id=app.actor_id() AND app.actor_active()));

-- Reading a stored citation needs both the conversation and, right now, the version.
CREATE POLICY ai_turn_citations_read ON app.ai_turn_citations FOR SELECT TO intradocs_app
 USING(app.can_read_version(version_id)
  AND EXISTS(SELECT 1 FROM app.ai_turns t JOIN app.ai_conversations c ON c.id=t.conversation_id
             WHERE t.id=turn_id AND c.user_id=app.actor_id() AND app.actor_active()));
-- Writing one is only possible for a version the owner can read at that moment, which
-- is already true of anything that survived citation validation.
CREATE POLICY ai_turn_citations_write ON app.ai_turn_citations FOR INSERT TO intradocs_app
 WITH CHECK(app.can_read_version(version_id)
  AND EXISTS(SELECT 1 FROM app.ai_turns t JOIN app.ai_conversations c ON c.id=t.conversation_id
             WHERE t.id=turn_id AND c.user_id=app.actor_id() AND app.actor_active()));

GRANT SELECT,INSERT,UPDATE(title,updated_at),DELETE ON app.ai_conversations TO intradocs_app;
GRANT SELECT,INSERT ON app.ai_turns TO intradocs_app;
GRANT SELECT,INSERT ON app.ai_turn_citations TO intradocs_app;
