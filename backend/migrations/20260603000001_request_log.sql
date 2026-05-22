-- ──────────── 020 request_log — per-request performance capture ────────────
-- One append-only row per HTTP request: route, status, latency. Powers
-- the performance side of the monitoring dashboard — "how long does a
-- table refresh take", error rate, slow routes — measured, not felt.
--
-- `route` is the request path with RedPash-ID segments collapsed to
-- `:id`, so /api/files/FIL_…/page aggregates as one route. Plain
-- BIGSERIAL PK — a metrics row is not an addressable entity, so it
-- carries no RedPash-ID.
--
-- Written fire-and-forget by routes::capture_mw — measuring the app
-- must never slow, or fail, the app.

CREATE TABLE IF NOT EXISTS request_log (
    id          BIGSERIAL    PRIMARY KEY,
    at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    method      TEXT         NOT NULL,
    route       TEXT         NOT NULL,
    status      SMALLINT     NOT NULL,
    duration_ms INTEGER      NOT NULL,
    request_id  TEXT
);

-- newest-first scans (the dashboard's recent-requests / time window).
CREATE INDEX IF NOT EXISTS request_log_at_idx ON request_log (at DESC);
-- per-route latency aggregation over a window (p50 / p95 by route).
CREATE INDEX IF NOT EXISTS request_log_route_idx ON request_log (route, at DESC);
