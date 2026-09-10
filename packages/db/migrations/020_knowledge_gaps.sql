-- S10/V1: aggregated knowledge gaps -- what people look for and do not find.
--
-- This is the first time IntraDocs stores what was typed into search, so the shape is
-- deliberately narrow. ARCHITECTURE.md requires popular queries to be redacted or
-- curated rather than published raw, and the PRD forbids showing raw sensitive questions
-- on a cross-unit dashboard. Three controls, together, are what make this safe to show:
--
--   1. Only a normalised form is kept: lowercased, punctuation removed, capped at 80
--      characters. Long or unusual strings -- the ones most likely to carry a secret
--      pasted into the box -- are dropped entirely rather than truncated.
--   2. A term is reported only when at least three DISTINCT people searched it. One
--      person's private question can never surface, however often they repeat it.
--   3. The text expires after 30 days while the counts stay, so KPIs survive but the
--      wording does not accumulate.
ALTER TABLE app.search_events ADD COLUMN query_norm text
 CHECK(query_norm IS NULL OR length(query_norm) BETWEEN 3 AND 80);
CREATE INDEX search_events_gap_idx ON app.search_events(created_at DESC)
 WHERE query_norm IS NOT NULL AND result_count=0;

-- Normalisation is a function so the recorder and any later analysis cannot disagree
-- about what counts as "the same" search.
CREATE FUNCTION app.normalise_query(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
  WHEN raw IS NULL THEN NULL
  -- Anything with a digit run of 6+, an @, or a long token is treated as possibly
  -- identifying and is not stored at all.
  WHEN raw ~ '[0-9]{6,}' OR raw ~ '@' OR raw ~ '[^[:space:]]{40,}' THEN NULL
  ELSE nullif(
   left(regexp_replace(lower(btrim(raw)), '[^[:alnum:][:space:]-]', ' ', 'g'), 80), '')
 END
$$;

/**
 * Terms that returned nothing, reported only above the k-anonymity threshold.
 *
 * Runs as the caller's own identity is NOT possible here -- the aggregate spans other
 * people's searches -- so it is SECURITY DEFINER and returns only counts, never who
 * searched. The unit filter narrows by the searcher's unit without exposing membership.
 */
CREATE FUNCTION app.knowledge_gaps(days integer, unit text DEFAULT NULL, min_actors integer DEFAULT 3)
RETURNS TABLE(term text, searches bigint, people bigint, last_seen timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT s.query_norm,count(*),count(DISTINCT s.actor_id),max(s.created_at)
 FROM app.search_events s
 WHERE s.query_norm IS NOT NULL AND s.result_count=0
  AND s.created_at >= now()-make_interval(days=>greatest(1,least(365,days)))
  AND (unit IS NULL OR EXISTS(SELECT 1 FROM app.profiles p WHERE p.id=s.actor_id AND p.unit=unit))
 GROUP BY s.query_norm
 HAVING count(DISTINCT s.actor_id) >= greatest(3,min_actors)
 ORDER BY count(*) DESC, max(s.created_at) DESC
 LIMIT 20
$$;

-- Retention: drop the wording, keep the row. Counts and latency stay available for the
-- KPI tiles; the text does not outlive its usefulness.
CREATE FUNCTION app.prune_search_queries() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE n integer; BEGIN
 UPDATE app.search_events SET query_norm=NULL
 WHERE query_norm IS NOT NULL AND created_at < now()-interval '30 days';
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.knowledge_gaps(integer,text,integer) OWNER TO intradocs_workflow;
ALTER FUNCTION app.prune_search_queries() OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.knowledge_gaps(integer,text,integer),app.prune_search_queries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.normalise_query(text) TO intradocs_app,intradocs_workflow;
-- Reading the aggregate needs the analytics capability, which the application checks
-- before calling; the grant keeps it off every other role regardless.
GRANT EXECUTE ON FUNCTION app.knowledge_gaps(integer,text,integer) TO intradocs_app;
GRANT EXECUTE ON FUNCTION app.prune_search_queries() TO intradocs_worker;
GRANT UPDATE(query_norm) ON app.search_events TO intradocs_workflow;
