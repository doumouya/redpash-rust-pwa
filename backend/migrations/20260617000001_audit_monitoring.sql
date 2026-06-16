-- Monitoring: the `audit` schema — the in-app audit trail behind the Admin
-- Monitoring page (Phase-6, ported + adapted from prerelease).

-- WHY a separate schema: audit.run / audit.finding are PLATFORM-OPS rows, NOT
-- registry entities — they record the audit suite's runs (the same suite behind
-- the ci-audit ratchet), so audit health is observable in-app, not only in CI
-- logs. They carry no register_entity row and no RBAC cascade; the
-- /api/monitoring read surface gates them at the handler (platform-admin only,
-- leak-free 404).
--
-- LEAN ADAPTATIONS vs prerelease:
--  * `tool` has NO CHECK constraint — lean's suite is ~28 tools and grows; the
--    `redpash-audit-ingest` discovery loop validates the name instead. A closed
--    enum here would force a migration per new tool (the closed-enum trap).
--  * findings are uniform {file,line,rule,msg}; the ingest explodes them
--    GENERICALLY (kind = rule, finding_key = rule|file:line, severity = NULL),
--    replacing prerelease's bespoke per-tool exploders.
--
-- run.payload is the source of truth (the whole audit.json); run.stats is the
-- human summary ({} or {count} when a tool emits no stats). finding is the
-- exploded projection so run_diff is a plain self-join on (kind, finding_key).

CREATE SCHEMA audit;

CREATE TABLE audit.run (
    id         BIGSERIAL PRIMARY KEY,
    tool       TEXT NOT NULL,
    ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    git_sha    TEXT,
    git_branch TEXT,
    stats      JSONB NOT NULL,
    payload    JSONB NOT NULL,
    UNIQUE (tool, git_sha, ran_at)
);
CREATE INDEX audit_run_tool_time_idx ON audit.run (tool, ran_at DESC);

CREATE TABLE audit.finding (
    run_id      BIGINT NOT NULL REFERENCES audit.run(id) ON DELETE CASCADE,
    tool        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    finding_key TEXT NOT NULL,
    severity    INTEGER,
    detail      JSONB NOT NULL,
    PRIMARY KEY (run_id, finding_key)
);
CREATE INDEX audit_finding_key_idx ON audit.finding (tool, kind, finding_key);

-- run_diff(cur,prev): classify each finding by (kind,finding_key) presence +
-- severity delta → new | fixed | regressed | improved | unchanged. Ported
-- verbatim from prerelease; the regression view (M3) reads it.
CREATE FUNCTION audit.run_diff(cur_id bigint, prev_id bigint)
    RETURNS TABLE(status text, kind text, finding_key text, severity_cur integer, severity_prev integer)
    LANGUAGE sql STABLE AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT, c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c LEFT JOIN prev p USING (kind, finding_key)
     WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT, p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p LEFT JOIN cur c USING (kind, finding_key)
     WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c JOIN prev p USING (kind, finding_key);
$$;
