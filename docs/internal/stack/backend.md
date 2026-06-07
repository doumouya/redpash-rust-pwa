---
title: Stack — Back-End
section: Internal
last modified date: 2026-06-07
---

# Stack — Back-End

The back-end is one Cargo workspace (`backend/`) of three crates, plus
the Postgres tables they read and write. It serves the HTTP API, runs
all data compute, and persists observability. This page is the
orientation layer: what each crate is for, how a request flows through
it, and where the deeper subsystem docs live. It describes the code as
it stands today, not the roadmap.

## The three-crate split

```
backend/crates/
├── api      — axum HTTP server. Routes, auth, middleware, DB queries.
├── data     — Polars compute. Parse, clean, step engine, stats. No HTTP.
└── shared   — wire DTOs. Both crates depend on it for typed request/response.
```

The split is a hard boundary, not a folder convention:

- **`api` owns the outside world** — HTTP, the session cookie, the
  Postgres pool, the filesystem. Handlers are thin: resolve the user,
  check ownership, call `data`, map errors to status codes, return a
  `shared` DTO. Long SQL lives under `api/src/db/` (one module per
  resource) so handlers stay the "shape + auth + error mapping" layer.
- **`data` owns compute and is HTTP-agnostic by construction.** Every
  byte enters as a buffer the caller supplies; every result exits as a
  typed struct or a `polars::DataFrame`. No `sqlx`, no `axum`, no
  `tokio::fs`. That property is what makes the same engine compile to
  `wasm32` and run in the browser unchanged — the runtime swap was
  free because the crate never reached for the network or the disk.
- **`shared` is the contract.** Request and response types live here so
  a route handler and the frontend that calls it can't drift —
  changing a field is a compile error on both sides at once.

Build: `cargo build --release` from `backend/`. Run dev: `cargo run -p
api` — that single command brings the whole app up because the API
server also serves the static frontend (below). Test: `cargo test
--workspace`.

## The route layer (`api`)

`routes::router(state)` assembles the entire HTTP surface and returns a
two-layer composition: an inner `/api/*` router of per-resource
sub-routers, wrapped by an outer router that serves the static frontend
on every non-`/api` path via `ServeDir("../frontend")`. Each resource
is its own module exposing `pub fn routes() -> Router<AppState>`,
nested under its URL prefix. Keeping the tree assembled in one file
makes the API surface auditable at a glance.

**Why one binary serves frontend + API.** `cargo run -p api` is the
whole dev environment — no separate static server, no proxy. In debug
builds the static fallback ships `cache-control: no-cache` so a normal
reload always picks up an edit (runbook 0009); release builds serve
fingerprinted assets and keep caching them. Compression is on for
everything via the outer `CompressionLayer` — the wasm engine relies on
it (an 11.5 MB binary delivers as ~3.3 MB over the wire).

**The middleware chain is ordered deliberately** (axum's `.layer()`
wraps, so the last-declared layer is outermost). On the `/api` subtree,
from outside in: `request_id_mw` → `capture_mw` → `DefaultBodyLimit` →
resource routers. The order is load-bearing — `request_id_mw` mints
`req_<uuid>` and stashes it in the request extensions *before*
`capture_mw` reads it, and `capture_mw` wraps the 256 MiB body limit so
a 413 lands in the event log too. `request_id_mw` also opens a
`tracing` span keyed by `request_id`, so every log line emitted during
the request inherits it — that is the spine of investigation: a 500 in
the events table pivots to the stdout log by grepping the same id.

**Auth resolution is shared, not per-handler.** `me::resolve_user_rid`
is the one helper every owner-scoped endpoint uses, with three
branches: valid `rp_session` cookie → look up the user; no/invalid
session and OAuth configured → 401; no session and OAuth disabled (dev
mode) → fall back to the bootstrap `dev_user`. The dev fallback exists
so solo-dev on localhost works without OAuth wired. Routes that enforce
ownership layer `ensure_owner` on top, which returns **404 on a
miss or a mismatch** — never 403. That is deliberate: a 403 would tell
an attacker the RID is valid but not theirs; a 404 keeps existence
private.

**Admin and monitoring are gated at the API layer, not just hidden in
the UI.** The `/admin`, `/monitoring`, and `/metrics` subtrees each
carry a `require_platform_admin_mw` middleware that resolves the caller
and 404s non-admins before any handler runs. This auto-covers every
current and future route under those prefixes — no per-handler gate to
forget — and closes the dev-permissive escalation where any authed user
could grant themselves Owner via `POST /admin/memberships`.

The full route catalog, the per-handler auth pattern, and the recipe
for adding a resource are in [api-routes](../subsystems/api-routes.md).

## The data engine (`data`)

`polars::DataFrame` is the universal currency — every module in `data`
takes and returns one. The `api` crate hydrates a frame once per file:
read bytes from `REDPASH_DATA_DIR/files/<rid>.bin`, run them through
`data::parse`, then replay the file's step history. The result is
cached on `AppState` in a `DashMap` keyed by file RID, so subsequent
page reads don't re-parse and re-replay; any mutation invalidates the
entry.

The crate's modules map cleanly to concerns: `encoding` (chardetng
detection, BOM short-circuit), `parse` (CSV/XLSX/JSON → DataFrame, plus
the wrapped-CSV rescue and the query-time filter), `dtype` (per-column
storage-vs-semantic type inference + light stats), `dedup` and `joins`
(set-based duplicate and join-key detection), `group_by` (the
aggregation engine Reports calls), `stats` (file-level cleanness
scoring), `clean` (the always-safe import transform), `steps` (the user
cleaning operations), and `export` (DataFrame → bytes). `render`
(Markdown/Maud for `/docs`) is hard-gated out of `wasm32` because its
syntect/crossterm deps don't compile there.

Two transforms anchor the cleaning story. `clean::auto_clean` runs
once on import and is always safe: trim whitespace, blank junk
sentinels (`""`, `NA`, `null`, `-`, …) to real nulls, drop fully
identical duplicate rows — returning a `CleanSummary` so the UI can
report "47 trimmed, 12 junk-blanked, 3 duplicates dropped" honestly.
Everything user-initiated is the step engine (next section). The
sentinel vocabulary is two-layered: a global canonical set plus
per-user `learned_sentinels` from preferences, merged at hydrate time.
The crate-level error is `DataError`; `api` maps it to HTTP status,
with `InvalidSpec` the load-bearing variant ("syntactically OK but
semantically wrong" — bad column reference, bad op) surfacing as
`kind="invalid_spec"`.

Algorithm depth, the Polars feature matrix, and the per-module
optimization map are in [data-engine](../subsystems/data-engine.md).

## The cleaning step engine

A **step** is one cleaning operation on one file — `{ kind, params }`
persisted as a `project_steps` row. The engine is what makes cleaning
**non-destructive**: the original bytes on disk never change. The
DataFrame the user sees is *not stored* — it is computed on demand from
`(base bytes) + (every applied step in ordinal order)`. `undo` and
`redo` flip the row's `applied` boolean rather than deleting it, so the
step history is the full chronological record and undo just chooses
which prefix is currently materialized.

`data::steps::apply(df, kind, params)` dispatches one match arm per
kind (17 today: `filter_rows`, `drop_columns`, `set_cell`,
`fill_nulls`, `cast`, `replace_text`, `unwrap_csv`, …). Each arm is
pure — DataFrame in, DataFrame out, no IO — which is exactly why the
engine compiles to wasm. The apply endpoint pre-flights every step
against a clone *before* persisting, so any step that ever made it into
the table is one we already executed successfully; replaying it on
every read is not a gamble. Adding a kind needs no migration —
`project_steps.kind` is free-form `text`, validated by the engine
recognising the string (unknown → `InvalidSpec`).

The catalog, the apply/undo/redo lifecycle, the cache-invalidation
contract, snapshots, and per-kind cost are in
[step-engine](../subsystems/step-engine.md).

## Events, request_log, and audit storage

The back-end captures three observability streams, all append-only and
all written **fire-and-forget** — observation must never slow or fail
the thing it observes. Every write site wraps its insert in
`tokio::spawn`; a DB failure on the log path emits a `tracing::warn`
and drops the row, leaving the foreground response untouched.

- **`request_log`** — one row per `/api/*` request (method, normalized
  route, status, duration). `capture_mw` writes it for every request,
  success or failure. Routes are normalized (`/files/FIL_…/page` →
  `/files/:id/page`) so per-file traffic aggregates instead of
  fragmenting. Backs `/api/metrics` (p50/p95/p99 via Postgres'
  `percentile_cont`) and the Monitoring Requests tab.
- **`events`** — the semantic stream: *what happened* worth knowing. A
  successful request lands in `request_log` with no event; a 4xx/5xx
  lands in both, the error context auto-recorded by `capture_mw` from
  the `EventInfo` extension `AppError` attaches. Lifecycle events
  (OAuth login success/failure) and frontend exceptions (via `POST
  /api/events`, the only client write path) also land here. `request_id`
  is the join key stitching a frontend action to the backend request
  that triggered it.
- **`audit.*`** (separate schema) — codebase-health history, not
  runtime data. The `tools/*-audit/audit.js` scripts scan a slice of
  the repo; for css and html the `redpash-audit-ingest` binary persists
  each run plus exploded per-finding rows, and the `audit.run_diff` SQL
  function classifies findings as new/fixed/regressed/improved/unchanged
  against the prior run. That "since last run" diff is the trigger for
  the cleaning cadence. Read-only via `/api/monitoring/audit-*`.

Both runtime tables are unbounded today (no retention job); growth is
negligible at solo-dev scale, and consumers must not bake in a
retention assumption. Details, write/read paths, and the SQL internals
are in [events-and-logs](../subsystems/events-and-logs.md) and
[audit-storage](../subsystems/audit-storage.md).

## Cross-cuts a new engineer should internalize

- **Handlers don't compute, `data` doesn't do IO.** If a handler grows
  a row-walking loop, it belongs in `data`; if a `data` module reaches
  for `sqlx` or `axum`, it belongs in `api`. The boundary is what keeps
  the wasm path alive.
- **Errors carry a stable `kind`.** `AppError::not_found("invalid_csv",
  …)` etc. — the kind flows into `events.context.error_kind`, which is
  how monitoring groups failures by category. Use the constructors, not
  ad-hoc status codes.
- **DataFrames are sync; handlers are async.** Compute runs inside the
  await boundary and holds a runtime thread — fine at current scale;
  revisit with `spawn_blocking` if individual files reach hundreds of
  MB.
- **Auth resolution is the most-called DB hit** (one indexed session
  lookup per authed request). Today's pool absorbs it; an in-memory
  session cache is the named lever if it ever becomes the bottleneck.

## Source files

Survival docs for the load-bearing source files behind this layer:

- [`backend/api/routes/mod`](../code/backend/api/routes/mod.md) — route assembly + the middleware chain
- [`backend/api/state`](../code/backend/api/state.md) — `AppState`: pool, DataFrame cache, dev_user, oauth
- [`backend/api/error`](../code/backend/api/error.md) — `AppError`, the stable `kind`, `EventInfo` attach
- [`backend/api/event`](../code/backend/api/event.md) — `event::record` fire-and-forget + `EventDraft`
- [`backend/api/request_log`](../code/backend/api/request_log.md) — per-request capture + `normalize_route`
- [`backend/api/routes/metrics`](../code/backend/api/routes/metrics.md) — `percentile_cont` KPI endpoint
- [`backend/api/routes/monitoring`](../code/backend/api/routes/monitoring.md) — the Monitoring page surface
- [`backend/api/bin/audit_ingest`](../code/backend/api/bin/audit_ingest.md) — `redpash-audit-ingest` + `explode`
- [`backend/data/lib`](../code/backend/data/lib.md) — the `data` crate root + module map + `DataError`
- [`backend/data/parse/mod`](../code/backend/data/parse/mod.md) — bytes → DataFrame + the query-time filter
- [`backend/data/clean`](../code/backend/data/clean.md) — `auto_clean` + the sentinel set
- [`backend/data/steps/mod`](../code/backend/data/steps/mod.md) — the step dispatch + apply/replay
- [`backend/data/group_by`](../code/backend/data/group_by.md) — the aggregation engine
- [`backend/data/stats`](../code/backend/data/stats.md) — `cleanness_pct` scoring
- [`backend/shared/lib`](../code/backend/shared/lib.md) — the wire-DTO contract crate
- [`backend/shared/step`](../code/backend/shared/step.md) — `StepRequest` / `ProjectStep` DTOs
- [`backend/shared/event`](../code/backend/shared/event.md) — `EventReport` / `Event` / `EventSummary` DTOs
