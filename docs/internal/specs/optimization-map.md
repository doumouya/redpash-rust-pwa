---
title: Optimization map — object spec
section: Internal
order: 33
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Optimization map — object spec

A first-class object that pairs **known optimization opportunities**
(the doc-side "Optimization map" tables in each subsystem doc) with
**live measurements** from the running system. Each row is one
optimization point — *what's the current cost, what's the horizon
where it tips, how does today's measured value compare?*

Surfaces as the **Optimization** tab on `/monitoring`. Read-only
for v1; status flips happen via direct DB UPDATE (Em's call,
manual today, admin UI later).

## TL;DR

1. **One new table** `optimization_points` — `(subsystem, phase)` is
   the natural key, but use `BIGSERIAL id` for the PK so the URL
   doesn't bake in the descriptive text.
2. **Live measurement is the load-bearing column** — each row
   declares a `measurement_kind` + `measurement_key`; the API
   evaluates them server-side on every fetch, joining against
   `request_log` / `audit.finding` / table row-counts.
3. **No new tracking infrastructure** — measurements are computed
   from already-captured data. This isn't observability, it's a
   *projection* over observability.
4. **Status lifecycle**: `open → planned → done` or `→ wontfix`.
   When a horizon tips and the work lands, the row stays in the
   table as a record of what was done; `done` rows render at the
   bottom of the table.

## 1. The shape — what each row holds

```sql
CREATE TABLE optimization_points (
    id                BIGSERIAL    PRIMARY KEY,
    subsystem         TEXT         NOT NULL,
    phase             TEXT         NOT NULL,
    current_cost      TEXT         NOT NULL,     -- human-readable
    horizon           TEXT         NOT NULL,     -- human-readable
    status            TEXT         NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','planned','done','wontfix')),
    -- Live measurement metadata. NULL = static row, no live value.
    measurement_kind  TEXT,                       -- see catalog below
    measurement_key   TEXT,                       -- kind-specific parameter
    threshold_value   DOUBLE PRECISION,           -- when current_value ≥ this, the horizon has tipped
    threshold_unit    TEXT,                       -- 'ms' | 'rows' | 'req_per_sec' | 'mb' | …
    notes             TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (subsystem, phase)
);
CREATE INDEX optimization_points_subsystem_idx ON optimization_points (subsystem);
CREATE INDEX optimization_points_status_idx    ON optimization_points (status);
```

Columns explained:

- `subsystem` — the doc anchor (e.g. `'api-routes'`, `'data-engine'`).
  Matches the slug under `docs/internal/subsystems/`.
- `phase` — the operation / hot path. Free-text but stable;
  refactors should update both the doc + the row.
- `current_cost` — the *current* state described, e.g.
  `"~1ms DB lookup per authed call"`. The doc-side phrasing,
  unchanged.
- `horizon` — the optimization trigger, e.g.
  `"in-memory session cache when >50 req/s"`. What the next move
  is + when it pays off.
- `status` — workflow state; controls render bucket.
- `measurement_kind` — declares which live measurement powers
  this row's "current value" column. NULL means static row
  (just renders the prose).
- `measurement_key` — kind-specific selector (e.g. route path,
  audit finding kind, table name).
- `threshold_value` + `threshold_unit` — the tipping point.
  Server compares `current_value` against it and colors the row.

## 2. Measurement kinds (v1)

The server-side evaluator computes a `current_value` per row by
dispatching on `measurement_kind`:

| `measurement_kind` | `measurement_key` | What it computes | Source |
|---|---|---|---|
| `route_p95_ms_24h` | `<method> <route>` (e.g. `"GET /me"`) | p95 latency over last 24h | `request_log` |
| `route_count_24h` | `<method> <route>` | request count over last 24h | `request_log` |
| `route_error_rate_24h` | `<method> <route>` | 4xx+5xx fraction over last 24h | `request_log` |
| `audit_finding_count` | `<tool>/<kind>` (e.g. `css/selector_conflict`) | distinct findings in the latest audit.run for that tool | `audit.finding` |
| `table_row_count` | `<table_name>` (whitelisted) | `SELECT COUNT(*) FROM <table>` | catalog of safe table names |
| `pool_max_idle_ms` | (none) | longest sqlx pool idle since boot | `state` snapshot |
| `none` | (none) | static row — no current_value | n/a |

Each kind is implemented in `routes::monitoring::evaluate_measurement(kind, key)`
as a match arm. Adding a new kind = one match arm + one entry
in this table.

**Whitelist for `table_row_count`** — keep an explicit set of
allowed tables (no user-input table names). Today's whitelist:
`users`, `projects`, `project_files`, `project_steps`,
`request_log`, `events`, `audit.run`, `audit.finding`,
`user_preferences`, `sentinel_submissions`. Anything else returns
NULL.

## 3. Wire DTO

```rust
// shared::optimization
pub struct OptimizationPoint {
    pub id:               i64,
    pub subsystem:        String,
    pub phase:            String,
    pub current_cost:     String,
    pub horizon:          String,
    pub status:           String,
    #[serde(default)] pub measurement_kind:  Option<String>,
    #[serde(default)] pub measurement_key:   Option<String>,
    #[serde(default)] pub threshold_value:   Option<f64>,
    #[serde(default)] pub threshold_unit:    Option<String>,
    #[serde(default)] pub notes:             Option<String>,
    pub created_at:       DateTime<Utc>,
    pub updated_at:       DateTime<Utc>,
    /// Live-evaluated; null when measurement_kind is null or the
    /// evaluator returned no data (empty window, etc.).
    #[serde(default)] pub current_value:     Option<f64>,
    /// Convenience: server-computed `current_value >= threshold_value`.
    /// null when either side is null.
    #[serde(default)] pub tipped:            Option<bool>,
}
```

## 4. Endpoint

```
GET /api/monitoring/optimization-points?page&size&subsystem&status
```

Returns `Page<OptimizationPoint>` — same paginated shape as the
other `/api/monitoring/*` endpoints, so the frontend's
`LIST_VIEWS` spec table grows by one entry and the tab renders
via the existing renderer.

Default sort: `status` (open before planned before done before
wontfix), then `subsystem`, then `phase`. The "what's left to
do" rises to the top.

Filters: `?subsystem=` `?status=`. Both optional, both ILIKE-
matched server-side.

Live evaluation: every fetch re-evaluates `current_value` for
each row. For 20 rows × ~5ms per evaluation = ~100ms total —
within the latency budget for a tab fetch. If row count climbs
past ~50, batch-evaluate kinds with one query per kind (e.g.
fetch p95 for all route_p95_ms_24h rows in one `GROUP BY route`).

## 5. Seed data

Migration N+1 seeds the table with one row per optimization-map
entry from the 8 subsystem deep-dives (commit f690550). Initial
status = `'open'`. Examples:

| subsystem | phase | current_cost | horizon | measurement_kind | measurement_key | threshold_value |
|---|---|---|---|---|---|---|
| api-routes | `resolve_user_rid` per call | ~1ms DB lookup | in-memory session cache when >50 req/s | `route_count_24h` | `GET /me` | 4320000 (≡50/s × 24h) |
| events-and-logs | `request_log` unbounded growth | linear; one row per request | retention policy (90d nightly TRUNCATE) when traffic justifies | `table_row_count` | `request_log` | 1000000 |
| omnisearch | ILIKE on `projects.name` | seq-scan, ~5ms at small scale | `pg_trgm` GIN index when projects grow | `table_row_count` | `projects` | 10000 |
| data-engine | step replay (cache miss) | O(n_steps × frame ops) | snapshot point past ordinal ~50 | `none` | — | — |
| wasm-engine | bundle delivery | 3.3 MB gz | feature-strip polars / lazy-load split | `none` | — | — |
| events-and-logs | error rate on `/projects` | ~17% (anon polling baseline) | review when 4xx exceeds 50% (real bug suspected) | `route_error_rate_24h` | `GET /projects` | 0.5 |

Static rows (`measurement_kind = 'none'`) carry guidance without
a live signal — useful for "this isn't measurable yet, but here's
the lever."

## 6. UI shape (Torv's lane)

New tab on `/monitoring` under a new `OPTIMIZATION` group (or
folded into AUDITS / a new group):

```
▼ REQUESTS
  📨 Events
  🌐 Requests
▼ AUDITS
  ▶ Runs
  ⚠ Findings
▼ OPTIMIZATION                       ← new group
  🔧 Map                              ← new tab
```

Body: KPI strip (Total · Open · Tipped · Done) + the redtable.

Columns: `Subsystem · Phase · Current cost · Live value · Threshold · Status`.

Cell rendering for **Live value**: color band by `tipped`:

- `null` (no measurement) — grey "—"
- `false` (under threshold) — neutral
- `true` (tipped, threshold exceeded) — warn / red

Sort by status group; tipped rows surface within each group.

## 7. Status workflow

Today: rows seeded as `open`. Manual UPDATE via psql / a future
admin UI changes status. Future enhancements:

- `PATCH /api/monitoring/optimization-points/:id` to flip status
  (RBAC-gated when it lands).
- A `done_at TIMESTAMPTZ` column when status flips to `done` —
  audit who/when. Out of v1 scope.
- Webhook / event when a row tips (status=`open` AND `tipped=true`)
  → sends to the events table, surfaces on the Events tab. The
  [[cleaning-cadence]] mechanic but for performance.

## 8. Scope

| Slice | LOC |
|---|---|
| Migration: table + indexes + seed rows | ~80 |
| `shared::optimization::OptimizationPoint` DTO | ~30 |
| `routes::monitoring::list_optimization_points` + `evaluate_measurement` | ~200 |
| Frontend: new MON_TABS entry + LIST_VIEWS row + KPI strip (Torv's lane) | ~80 |
| Status-flip endpoint (PATCH) — deferred, separate commit | ~50 |

v1 (backend): ~310 LOC across 3 files. ~3-4 hours.

## 9. Why this earns its place on `/monitoring`

The existing monitoring page surfaces **what's happening**
(events, requests, audits). The optimization map surfaces **what
the engineer should plan for next**, joined with the same live
data. Same "honesty by measurement" framing, different axis.

Cross-references between the redtable and the docs:
clicking a row's subsystem cell could open
`/docs/internal/subsystems/<subsystem>.md#optimization-map`. Not
in v1 but the schema supports it; the slug naming was intentional.

— Gus
