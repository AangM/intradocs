-- S09/V1 follow-up: conversational context for the assistant.
--
-- Until now every turn used a throw-away WeKnora session, so "kalau perangkatnya hilang
-- bagaimana?" after a question about MFA on the VPN was answered from nothing. A
-- conversation now keeps ONE WeKnora session for its lifetime and the agent is allowed
-- to read that session's own history (the person's earlier questions and the answers
-- they already saw). What does not change: retrieval is still scoped to the documents
-- the person may read on every turn (docs/WEKNORA.md §23), every citation is validated
-- against this database on every turn, and the session is discarded -- a fresh one is
-- created -- as soon as any earlier turn of the conversation cites a version the person
-- can no longer read, so a revoked document never lingers as model context either.
ALTER TABLE app.ai_conversations ADD COLUMN weknora_session_id text
 CHECK(weknora_session_id IS NULL OR length(weknora_session_id) BETWEEN 8 AND 128);
GRANT UPDATE(weknora_session_id) ON app.ai_conversations TO intradocs_app;
