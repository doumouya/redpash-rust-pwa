-- ──────────── 034 db_query_log — per-query DB observability ────────────
-- The DB-layer sibling of request_log (mig 020): one append-only row per
-- SQL query so the Monitoring "Queries" surface can answer "which queries
-- are slow / failing / hot" — measured, not felt. Em 2026-05-29: "all the
-- system should be monitored in verbose mode."
-- Scope: docs/internal/observability/db-monitoring.md.
--
-- Captured fire-and-forget by a sqlx tracing Layer (api/src/db_query.rs) —
-- measuring the DB must never slow, or fail, the DB. sqlx already logs the
-- *parameterized* statement (placeholders, not bound values), so the
-- captured `query_template` carries no PII.
--
-- Volume: grows N-queries-per-request faster than request_log (which is
-- already flagged for unbounded growth, optimization-points mig 026), so a
-- retention cleanup ships with it (REDPASH_DB_LOG_RETENTION_DAYS, default
-- 7) — see api/src/db_query.rs. Plain BIGSERIAL PK: a metrics row is not an
-- addressable entity, so it carries no RedPash-ID.
--
-- request_id / user_redpash_id / route correlate to request_log + events
-- via the per-request "api" span; nullable for queries outside a request
-- (boot, the retention job itself, background tasks).

CREATE TABLE IF NOT EXISTS db_query_log (
    id              BIGSERIAL    PRIMARY KEY,
    at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    query_template  TEXT         NOT NULL,   -- parameterized SQL, no bound values
    duration_ms     INTEGER      NOT NULL,
    rows            BIGINT,                  -- affected/returned, nullable
    status          SMALLINT     NOT NULL DEFAULT 0,  -- 0 ok / 1 error
    error_kind      TEXT,
    request_id      TEXT,
    user_redpash_id TEXT,
    route           TEXT
);
CREATE INDEX IF NOT EXISTS db_query_log_at_idx       ON db_query_log (at DESC);
-- per-template latency aggregation over a window (p50 / p95 by query shape)
CREATE INDEX IF NOT EXISTS db_query_log_template_idx ON db_query_log (query_template, at DESC);
-- correlate a request to the queries it issued
CREATE INDEX IF NOT EXISTS db_query_log_request_idx  ON db_query_log (request_id) WHERE request_id IS NOT NULL;
