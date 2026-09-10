-- S01/V1: replace the hand-picked starter topics with measured ones.
--
-- Same machinery as knowledge_gaps, with two deliberate differences.
--
-- Only searches that FOUND something are counted. A term nobody could resolve says
-- nothing useful to a newcomer, and it belongs on the admin gap list instead.
--
-- The threshold is higher here, five distinct people rather than three. The gap list is
-- capability-gated and unit-scoped; this one is on the front page for every signed-in
-- person, so a term reaches it only after it is common enough that showing it tells no
-- one anything they could not have found by searching themselves.
CREATE FUNCTION app.popular_searches(days integer DEFAULT 30, min_actors integer DEFAULT 5)
RETURNS TABLE(term text, searches bigint, people bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT s.query_norm,count(*),count(DISTINCT s.actor_id)
 FROM app.search_events s
 WHERE s.query_norm IS NOT NULL AND s.result_count > 0
  AND s.created_at >= now()-make_interval(days=>greatest(1,least(365,days)))
 GROUP BY s.query_norm
 HAVING count(DISTINCT s.actor_id) >= greatest(5,min_actors)
 ORDER BY count(*) DESC, count(DISTINCT s.actor_id) DESC, s.query_norm
 LIMIT 6
$$;
GRANT CREATE ON SCHEMA app TO intradocs_workflow;
ALTER FUNCTION app.popular_searches(integer,integer) OWNER TO intradocs_workflow;
REVOKE CREATE ON SCHEMA app FROM intradocs_workflow;
REVOKE ALL ON FUNCTION app.popular_searches(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.popular_searches(integer,integer) TO intradocs_app;
