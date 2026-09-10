-- Fix for 020. Measured against the function as shipped there:
--   '  VPN, Windows!  ' -> 'vpn  windows '   (double space, trailing space)
--   'ab'                -> 'ab'              (2 chars, violates the CHECK on insert)
-- Runs of whitespace now collapse to one and the result is trimmed, so the same search
-- typed with different spacing aggregates as one term instead of several. Anything under
-- three characters is dropped rather than stored, matching the column constraint instead
-- of failing the insert at run time.
CREATE OR REPLACE FUNCTION app.normalise_query(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
  WHEN raw IS NULL THEN NULL
  WHEN raw ~ '[0-9]{6,}' OR raw ~ '@' OR raw ~ '[^[:space:]]{40,}' THEN NULL
  ELSE nullif(
   (SELECT CASE WHEN length(t) BETWEEN 3 AND 80 THEN t END
    FROM (SELECT btrim(regexp_replace(
      regexp_replace(lower(btrim(raw)), '[^[:alnum:][:space:]-]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g')) AS t) x),
   '')
 END
$$;
