-- ──────────── audit.run_diff — change-tracking across two runs ────────────
-- Parameterized projection over audit.finding that classifies each
-- finding relative to a previous run:
--
--   new        finding_key exists in cur, not in prev
--   fixed      finding_key exists in prev, not in cur
--   regressed  finding_key in both, cur.severity > prev.severity
--   improved   finding_key in both, cur.severity < prev.severity
--   unchanged  finding_key in both, severity equal
--
-- A function (not a view) because the diff is parameterized by
-- (cur_id, prev_id) — the caller picks which two runs to compare. The
-- ingest binary calls this immediately after inserting a new run, with
-- prev_id = the most recent earlier run for the same tool.
--
-- STABLE because it only reads; can be called inline in SELECTs.
-- Joins on (kind, finding_key) — finding_key is unique within a run by
-- the PK on audit.finding, but pinning kind too is defensive against any
-- future explode that lets the same string mean different things.
--
-- Idempotent via CREATE OR REPLACE so a manual psql apply and the
-- sqlx::migrate! pass at backend boot don't collide.

CREATE OR REPLACE FUNCTION audit.run_diff(cur_id BIGINT, prev_id BIGINT)
RETURNS TABLE (
    status        TEXT,
    kind          TEXT,
    finding_key   TEXT,
    severity_cur  INTEGER,
    severity_prev INTEGER
)
LANGUAGE SQL
STABLE
AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT,
           c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c
      LEFT JOIN prev p USING (kind, finding_key)
     WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT,
           p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p
      LEFT JOIN cur c USING (kind, finding_key)
     WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c
      JOIN prev p USING (kind, finding_key);
$$;
