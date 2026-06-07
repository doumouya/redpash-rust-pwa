---
title: DB observability — scope
section: Internal
order: 61
last modified date: 2026-05-29
owner: Torv
status: scope / not built — design for capturing the DB layer the way request_log captures the HTTP layer
---

# DB observability — scope

Em 2026-05-29: "all the system should be monitored in verbose mode."
Today the **application** layer is well captured (`request_log` =
per-HTTP-request; `events` = errors/panics/actions; structured JSON to
stdout). The **database** layer is the gap: sqlx logs every query, but
*only to the stdout tracing stream* (`sqlx=info`) — nothing persists
query timings, slow queries, or pool health to a queryable surface. DB
*errors* bubble up as `AppError` → an `events` row, so failures are
visible; DB *performance* is invisible in-app.

This scopes closing that gap — capturing the DB layer like we capture
HTTP — under the [[project-audit-everything]] principle: **verbose mode
captures everything; log levels filter the *view*, never the capture.**

---

## 1. What to capture

**Per-query record** (the verbose unit — mirrors a `request_log` row):
- `query_template` — the normalized SQL, **placeholders only, never
  bound values** (see §4 redaction).
- `duration_ms`, `rows` (affected/returned, nullable).
- `status` (ok / error) + `error_kind` (nullable).
- `request_id` — correlates to `request_log` + `events` (the existing
  correlation backbone).
- `user_redpash_id`, `route` — the caller + HTTP route that issued it.

**Pool / connection health** (periodic snapshot, *not* per-query): pool
size, idle/active, acquire-wait, timeouts. Low frequency — a sampler or
computed on demand. (Phase 2; per-query is the core.)

**DB errors** already land in `events` as `AppError`; optionally enrich
with the DB-specific kind (constraint / deadlock / timeout).

## 2. Where — a new `db_query_log` table

Mirrors `request_log` exactly (a metrics row, not an addressable entity
→ plain `BIGSERIAL`, no RID; append-only; fire-and-forget):

```sql
CREATE TABLE db_query_log (
  id              BIGSERIAL   PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_template  TEXT        NOT NULL,   -- normalized SQL, no bound values
  duration_ms     INTEGER     NOT NULL,
  rows            BIGINT,
  status          SMALLINT    NOT NULL,   -- 0 ok / nonzero error
  error_kind      TEXT,
  request_id      TEXT,                   -- correlate to request_log / events
  user_redpash_id TEXT,
  route           TEXT
);
CREATE INDEX db_query_log_at_idx        ON db_query_log (at DESC);
CREATE INDEX db_query_log_template_idx  ON db_query_log (query_template, at DESC); -- per-shape p50/p95
CREATE INDEX db_query_log_request_idx   ON db_query_log (request_id);
```

Separate high-volume table, *not* the `events` table — same reason
`request_log` is separate: events is for discrete meaningful records,
not a per-query firehose.

## 3. How — the capture mechanism

HTTP capture is an axum middleware (`capture_mw`); DB capture lives at
the **sqlx layer**, so it's a different hook. Two options:

- **(Recommended) a custom `tracing` Layer** subscribing to sqlx's query
  events (sqlx already emits SQL + elapsed at `sqlx=info`). The layer
  pulls SQL + elapsed + `request_id` (from the active request span) and
  **fire-and-forgets** a `db_query_log` insert. Zero call-site changes,
  captures every query, and the layer is the natural toggle point for
  verbose mode + the slow threshold. Reuses sqlx's existing
  instrumentation — leanest path.
- (Alt) a sqlx `Executor` wrapper that times each query structurally.
  No log-parsing, but it touches the db layer + every call site — more
  invasive. Hold unless the Layer proves fragile.

**Fire-and-forget, always** (like `event::record` + `request_log`): the
insert spawns onto the runtime; the query path never waits on its own
measurement. *Measuring the DB must never slow the DB.*

**Correlation:** the query runs inside the request span (carrying
`request_id` from `request_id_mw`), so the layer stitches
`db_query_log ↔ request_log ↔ events` for free — click a slow request →
its queries; click a slow query → its request.

## 4. Verbose mode, retention, redaction

- **Verbose toggle** (env / runtime setting):
  - **ON** → capture *every* query (full firehose — investigation mode).
  - **Default** → capture only slow queries (> threshold, e.g. 50ms) +
    all errors.
  - Per [[project-audit-everything]]: verbose is the *full-capture*
    mode; the Monitoring **view** always filters by level / slow / route
    regardless of capture mode. (At per-query volume, capturing
    everything *forever* is a real firehose, so the toggle is the
    capture control — but the view-filtering principle still holds.)
- **Retention — mandatory from day one.** `request_log` already carries
  a flagged optimization-point ("request_log unbounded growth", 1M-row
  threshold); `db_query_log` grows *N-queries-per-request faster*, so it
  needs its **own, more aggressive** retention: a time-window cleanup
  (e.g. verbose rows 24–48h, slow/error rows kept longer) or a ring-cap.
  Without it, this table dwarfs everything. ([[feedback-scale-perspective]])
- **Param redaction — non-negotiable.** Capture the query *template*
  (placeholders), never bound values — bind params carry PII / customer
  data / secrets. Extend `redact.rs`. Logging raw bound SQL is a
  data-leak surface; the template + timing is all the perf view needs.

## 5. The Monitoring surface

A new tab mirroring **Requests** (HTTP perf → DB perf, siblings):
- `GET /api/monitoring/queries` + a `MON_TABS` entry — "Queries" in the
  `REQUESTS` group (or a new `DATABASE` group if pool-health joins it
  later).
- View (same shape as the Requests tab): recent queries (template,
  duration, rows, status, route, request_id), **slow-query highlight**,
  **per-template aggregates** (count + p50/p95 by query shape), an error
  filter. Reuses the shared `list-page` + `wireListColumnsExport`
  machinery — no new table UI.

## 6. Two axes (audit-everything)

- **Runtime capture:** `db_query_log` rows (above).
- **Static catalog:** the `observability-audit` catalog gains DB-query
  capture as a "wired" entry; optionally a query over the slow threshold
  becomes an `audit.finding` (so regressions surface in the Findings
  tab). Phase 2.

---

## Open decisions (need Em)

1. **Retention window** — verbose rows (24h? 48h?) vs slow/error rows
   (kept longer?).
2. **Slow threshold** for default (non-verbose) capture — 50ms? 100ms?
3. **Verbose toggle granularity** — global env var, or a runtime
   setting flippable from the UI?
4. **Surface placement** — a "Queries" tab in the `REQUESTS` group, or a
   new `DATABASE` group (room for a pool-health view alongside)?
5. **Mechanism** — tracing Layer (lean, recommended) vs Executor wrapper
   (structured, invasive)?

## Build slices (when it's greenlit)

1. Migration: `db_query_log` table + indexes + the retention job.
2. `redact.rs`: SQL-template normalizer (strip bound values).
3. The sqlx tracing Layer → fire-and-forget capture (verbose + threshold).
4. `GET /api/monitoring/queries` reader (paginated, like requests).
5. FE: `MON_TABS` entry + the Queries tab (reuse the list-page surface).
6. Optional: pool-health sampler + the audit-finding bridge.

Related: [[observability-investigations]] (the gap this fills),
[[project-audit-everything]], [[project-logs-monitoring-dashboard]],
[[feedback-scale-perspective]].
