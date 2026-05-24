# Observability investigations — operator workflow + gap analysis

**Status**: slice A of the audit-everything workstream
([[project-audit-everything]]). Em's framing: *"An app is allowed to
fail, but not for too long. To solve a bug fast, we have to find its
root cause faster. The only way to achieve that is by capturing the
logs."*

This doc names the operator-side investigations we'd run against the
running app, derives the surfaces each needs, and identifies the gaps
between what the [observability-audit catalog](../../../tools/observability-audit/audit.json)
inventories and what the workflows need.

The catalog answers *what's wired*. This doc answers *can we run an
investigation end-to-end against what's wired*. The gaps below are the
slice-B+ shopping list.

---

## What's wired today (from the catalog)

Brief inventory; the [audit](../../../tools/observability-audit/audit.js)
output is the source of truth.

**Backend correlation (green):**
- `request_id_mw` mints `req_<uuid>` per request, stores in extensions,
  echoes as `X-Request-Id` response header
  ([backend/crates/api/src/routes/mod.rs:88](../../../backend/crates/api/src/routes/mod.rs#L88)).
- `capture_mw` stamps every 4xx/5xx response into the `events` table
  with `request_id`, `http_method`, `http_path`, `http_status`,
  `duration_ms`, `user`, `session_id`
  ([routes/mod.rs:104](../../../backend/crates/api/src/routes/mod.rs#L104)).
- `request_log::record` fire-and-forgets every request into
  `request_log` table (method, normalised route, status, duration_ms,
  request_id) — feeds the Monitoring latency board
  ([backend/crates/api/src/request_log.rs](../../../backend/crates/api/src/request_log.rs)).

**Backend events (green):**
- 35 `event::record` call sites across 11 files; cat-3 audit-trail
  backfill landed 2026-05-24 ([commits 3e6d2bd / dda6ee9 / 5082007]).
- `EventDraft` carries kind, message, user, session_id, request_id,
  http_method, http_path, http_status, duration_ms, context (JSONB).

**Frontend capture (green):**
- `events.js` has both `window.onerror` and `unhandledrejection`
  handlers; both feed `reportEvent` → `POST /api/events`
  ([frontend/scripts/events.js](../../../frontend/scripts/events.js)).
- `reportEvent` signature accepts `request_id` (wire-ready).

**Audit-run history (green):**
- 4 audit tools emit `audit.json`: auth-audit, css-audit, html-audit,
  observability-audit. js-audit + rs-audit emit reports without
  JSON sidecar (cleanup candidate, separate slice).

**Red — confirmed gaps:**
- `#[tracing::instrument]` zero hits — no span-based per-request
  child-work attribution.
- `panic::set_hook` absent — panic on a tokio task is invisible to
  `events`.
- Frontend doesn't read `X-Request-Id` from fetch responses —
  `reportEvent` accepts the field but no caller populates it.

---

## Operator investigations

Each investigation is a real question an operator (Em today, an oncall
later) asks when a bug report lands. Each names: the query they'd run,
the surfaces it touches, and what would fail today.

### I-1. "User X reports the Workspace was slow at 14:35."

**Query.** Pull every request user X made between 14:30 and 14:40,
sorted by `duration_ms DESC`.

```sql
SELECT rl.created_at, rl.method, rl.route, rl.status, rl.duration_ms,
       rl.request_id
  FROM request_log rl
  JOIN sessions s ON s.redpash_id = -- TODO: request_log has no session
 WHERE rl.created_at BETWEEN '2026-05-24 14:30' AND '2026-05-24 14:40';
```

**Surfaces needed:** `request_log` (✓ exists, ✓ has request_id).

**Gap:** `request_log` has no `user_redpash_id` or `session_id` column.
Today you can pull "every request in the window" but not "every request
*by this user*". The session_id is on the request via the cookie, but
isn't persisted to `request_log`. The same data is on `events` for 4xx/5xx
rows — but successful slow requests don't land in `events`, so they're
invisible per-user.

> **Slice candidate:** add `user_redpash_id` and `session_id` columns to
> `request_log`, populate from `capture_mw`. ~15 LOC + migration.

---

### I-2. "User Y got a 500 on /api/files/CHT_xxx/page at 16:22 — root-cause it."

This is exactly today's chart-RID bug class.

**Query.** Pull the event row, the request_log row, the user's last 10
actions before, the server-side tracing line.

```sql
-- the error event
SELECT * FROM events
 WHERE level = 'error' AND http_status = 500 AND user_redpash_id = $1
   AND occurred_at >= '2026-05-24 16:22' ORDER BY occurred_at LIMIT 1;
-- gives us request_id

-- the request_log row (latency + route)
SELECT * FROM request_log WHERE request_id = $2;

-- the user's last 10 events before
SELECT * FROM events
 WHERE user_redpash_id = $1 AND occurred_at < $3
 ORDER BY occurred_at DESC LIMIT 10;
```

**Surfaces needed:** `events` (✓), `request_log` (✓), correlation by
`request_id` (✓), structured JSON log stream (✓ — slice B/C `f2b3d72`).

**The log↔DB pivot (canonical I-2 workflow).** With slice B + Torv's
airlock (f2b3d72) in place, the stdout JSON log line for the 500 looks
like:

```json
{"timestamp": "...", "level": "ERROR",
 "fields": {"status": "500", "kind": "db", "message": "internal database error",
            "error.chain": "sqlx::Error: connection lost: 08006: ...",
            "error.debug": "Report { ... backtrace if RUST_BACKTRACE=1 ... }"},
 "span": {"request_id": "req_abc…", "name": "api"}}
```

Operator workflow:

```bash
# 1. pull the 500 event, grab request_id
$ psql -c "SELECT request_id FROM events WHERE level='error' AND user_redpash_id='USR_…' ORDER BY occurred_at DESC LIMIT 1"
 request_id
 ────────────
 req_abc…

# 2. pivot to the JSON log stream for the rich chain
$ jq 'select(.span.request_id == "req_abc…")' app.log
{"level": "ERROR", "fields": {"error.chain": "...", "error.debug": "..."}, ...}

# 3. for cross-handler timing inside the same request
$ jq 'select(.span.request_id == "req_abc…") | {ts: .timestamp, target, message: .fields.message}' app.log
```

The `error.chain` field carries the full source walk (sqlx →
PgError → connection details); `error.debug` adds the backtrace
when RUST_BACKTRACE is set. Channel B (the events row) carries
only sanitized `kind` + `message` per the airlock discipline — the
radioactive payload (eyre::Report) lives in Channel A only and
is dropped after the log emit.

**Remaining gap.** The "user's last 10 actions" trail is mostly
empty for non-error paths. `events` captures lifecycle events
(project_create, file_upload, chart_create, etc) — but most
navigation, panel-opens, filter-applies don't emit events. The
trail is sparse on the FE side.

> **Slice candidate:** broaden interaction-event coverage on the
> FE via the `track(kind, context)` helper extension to
> `scripts/events.js` (Torv's lane, slice C/D). Each "meaningful
> action" call site emits via one funnel + auto-attaches
> request_id from the response header. Then I-2's "last 10
> actions" feed is rich enough to reconstruct what the user was
> doing.

---

### I-3. "Charts dashboard isn't loading for user Z."

**Query.** Walk dashboard rid → widget chart RIDs → which one is
failing → why.

**Surfaces needed:** the GET /api/dashboards/:rid response (which lists
widget CHT_ refs) → GET /api/charts/:rid for each widget → if any 500,
fall back to I-2.

**Gap.** The catalog is fine for the per-call resolution. The deeper
gap: there's no notion of a **trace tree** for a single user action.
"Loading the dashboard" fires ~5-15 sub-requests in parallel (one per
widget); the operator wants the whole tree, not 15 disjoint events.

A request_id ties each sub-request to its own row, but there's no
parent-trace-id tying the 15 sub-requests to the one user click.

> **Slice candidate:** introduce a `trace_id` (client-minted) carried in
> a header alongside `X-Request-Id`. FE attaches `X-Trace-Id` to every
> fetch spawned by a single user action. BE stores it on `events` +
> `request_log`. The operator pulls "every row with trace_id=t_abc"
> and gets the tree. ~40 LOC FE + ~10 LOC BE + migration.
>
> Deferable — slice 3-4 of the workstream. I-1 and I-2 cover most
> investigations.

---

### I-4. "File upload was reported as failing. Show me the upload event + every step that ran on it after."

**Query.**

```sql
-- the upload event (already captured via event::record in routes/files.rs::upload)
SELECT * FROM events
 WHERE kind = 'file_upload' AND user_redpash_id = $1
 ORDER BY occurred_at DESC LIMIT 1;
-- gives us context.file rid

-- every step run on that file
SELECT * FROM project_steps WHERE file_redpash_id = $2 ORDER BY created_at;
-- every event referencing that file
SELECT * FROM events WHERE context->>'file' = $2 ORDER BY occurred_at;
```

**Surfaces needed:** `events` (✓), `project_steps` (✓), `events.context`
JSON path query (✓ — Postgres GIN-indexes JSONB by default).

**Gap.** None for this one. The cat-3 audit-trail backfill made this
investigation possible — pre-2026-05-24 the per-file event trail would
have been near-empty.

---

### I-5. "Where does the system spend time during cold start? Profile init() to first-request-served."

**Query.** Walk `state::AppState::init()` step-by-step, latency per
sub-task.

**Surfaces needed:** structured timing of init sub-tasks.

**Gap.** The catalog has 6 ad-hoc `Instant::now() + .elapsed()` sites,
but they're scattered and don't compose into a startup profile. Zero
`#[tracing::instrument]` macros — so init's child tasks (DB pool,
file-data dir mount, dev-user resolution) have no automatic latency
capture.

> **Slice candidate:** instrument the cold-start path with
> `#[tracing::instrument(level = "info")]` on `AppState::init` and its
> first-level callees. The tracing layer at the right log level dumps a
> hierarchical timing tree at boot. Same pattern then applies to hot
> handlers post-shipping. Pairs with I-2 slice candidate 2 (TraceLayer
> config).

---

### I-6. "What does the system look like NOW vs 24h ago? Are events/request rates trending up?"

**Query.** Time-bucket events + request_log over the last 24h.

```sql
-- requests per minute, last 24h
SELECT date_trunc('minute', created_at) AS bucket, COUNT(*)
  FROM request_log
 WHERE created_at >= now() - interval '24 hours'
 GROUP BY bucket ORDER BY bucket;
```

**Surfaces needed:** `request_log` (✓), the Monitoring page chart layer (✓).

**Gap.** None on data. The visualization is on the Monitoring page;
that's already a polish-lane card if Em wants finer granularity.

---

### I-7. "A user's session went sideways — replay every action they took."

**Query.** Every event + every request, in time order, for one
session_id.

```sql
SELECT 'event' AS kind, occurred_at, level, message, http_path, http_status
  FROM events WHERE session_id = $1
UNION ALL
SELECT 'request' AS kind, created_at, NULL, route, NULL, status
  FROM request_log WHERE request_id IN (
    SELECT request_id FROM events WHERE session_id = $1 AND request_id IS NOT NULL
  )
 ORDER BY 2;
```

**Surfaces needed:** `events.session_id` (✓), `request_log` (needs
session linkage — see I-1 gap).

**Gap.** Two:

1. Same as I-1: `request_log` has no `session_id` column. The UNION
   above falls back to "requests that already produced an event" — i.e.
   only the error path. Successful requests are invisible to the
   session replay.

2. As in I-2 gap 1: most FE navigations don't emit events, so the
   session replay's event-side is sparse. The "1000 clicks before the
   error" pattern is the highest-value bug report and the trail is
   thinnest there.

---

### I-8. "Did a panic happen on a background task? When?"

**Query.** Search events for panic messages or process-level marker.

**Surfaces needed:** a panic hook that records to `events`.

**Gap.** **Red.** `panic::set_hook` is absent. A tokio task that panics
today logs to stderr (default panic handler) but doesn't record to
`events`. The operator has no DB-side trail.

> **Slice candidate:** install a process-level panic hook in `main.rs`
> that calls `event::record` with `kind: "panic"`, `level: "error"`,
> message = panic payload. ~15 LOC. High-priority because today's "no
> trail at all" is the worst case.

---

## Gap summary (priority-ordered)

Status as of 2026-05-24 23:00 — slice B (1b47643) + Torv's airlock
(f2b3d72) closed gaps 1, 2, 3, 8 + delivered the JSON-output bonus.
The audit catalog has surfaces for each new piece (B-LOG.json-format,
B-LOG.airlock-inner, B-LOG.airlock-discipline, B-LOG.severity-split,
B-PANIC.tracing-emit, B-PANIC.backtrace, B-CORR.span, B-REQ.user-session).

| # | Gap | Investigations | Status | Notes |
|---|-----|----------------|--------|-------|
| **1** | tower_http log line doesn't print request_id | I-2 | ✅ slice B `1b47643` | request_id_mw opens `info_span!("api", request_id=…)`; every macro inside the request inherits the field |
| **2** | `request_log` missing `user_redpash_id` + `session_id` | I-1, I-7 | ✅ slice B `1b47643` | migration 027 + capture_mw populates both on every request |
| **3** | `panic::set_hook` absent | I-8 | ✅ slice B `1b47643` + airlock `f2b3d72` | hook records to events table AND emits `tracing::error!` with `Backtrace::force_capture()` |
| **8** | `RUST_LOG` defaults to `info` — verbose pre-market wants `sqlx=info` | (all) | ✅ slice B `1b47643` | default now `info,sqlx=info,hyper=warn,tower_http=info` |
| **A** | AppError carries no source chain — Channel A loses sqlx PgError details | I-2 | ✅ airlock `f2b3d72` | `inner: Option<eyre::Report>` + `error.chain` + `error.debug` fields; radioactive payload dropped at the wire |
| **B** | tracing output is pretty-text — `jq` filtering impossible | I-2, I-5, I-7 | ✅ airlock `f2b3d72` | `.json().flatten_event(true)`; span fields at the top level |
| **C** | All errors emit at WARN level — losing the severity signal | (all) | ✅ airlock `f2b3d72` | AppError::into_response splits 5xx-with-Report→ERROR / 4xx→WARN |
| **4** | FE doesn't read `X-Request-Id` from fetch responses | I-2 indirectly | 🔲 slice C (Torv) | reportEvent accepts the field; no caller populates it |
| **5** | FE interactions (nav / modal / filter) don't emit events | I-2, I-7 | 🔲 slice C/D (Torv) | `track(kind, context)` helper extension to `scripts/events.js`; one funnel, auto-attaches request_id |
| **6** | No `#[tracing::instrument]` spans → no sub-handler timing | I-5 | 🔲 slice E candidate | scattered `Instant::now()` today; spans unify |
| **7** | No `trace_id` for multi-request user actions | I-3 | 🔲 deferred | I-1+I-2 cover most cases |
| **9** | `console.log` proliferation (15 sites) — invisible to operator | I-7 (cleanup) | 🔲 cleanup-cadence | migrate to reportEvent per [[feedback-cleaning-cadence]] |
| **D** | PII leak risk in `error.chain` ({:#} on PgError can stringify binds) | (all post-RBAC) | 🔲 slice D | redaction wrapper + known-sensitive-field list; pair with body-logging discipline |
| **E** | 4xx-inner discipline ("constructors don't set inner") is convention, not types | (all) | 🔲 audit-catalog add | mechanical scan of `AppError::bad_request/not_found/conflict` callsites |

---

## Pre-market vs production gating

Em's framing: *"verbose mode while still not on the market"*. Build the
recording mechanisms now; gate intensity later.

**Knobs to expose** (slice-B candidates):

- `RUST_LOG` env var — already controls tracing macros, just bump default.
- `RP_EVENT_LEVEL` env var — caps the level events get persisted at
  (today everything goes through; for prod, drop debug-level events).
- `RP_REQUEST_LOG_BODY` env var — captures request body for non-error
  paths (verbose pre-market = on; prod = off by route).

Today: hardcode the "everything ON" mode. The env-var knobs land when
we have a second consumer (the prod ramp).

---

## Workflow conventions

Two patterns worth pinning so they survive the workstream:

1. **Investigation-driven design.** Each new observability slice
   declares which investigation it unlocks (referenced by I-N above).
   No "more logs because logs good" — every slice cites the operator
   query it makes possible.

2. **Catalog-first validation.** Each new surface lands a corresponding
   entry in [tools/observability-audit/audit.js](../../../tools/observability-audit/audit.js)'s
   `SURFACES` array. The audit verifies the wiring stays in place
   (regression net same as cat-1 / cat-3 / type-shape) — a surface
   that goes from green to red flags on the next audit run.

---

## What's next

Slice B candidates: gaps 1-3 above (TraceLayer request_id, request_log
session columns, panic hook). All three are sub-day work and unlock
investigations I-1 / I-2 / I-7 / I-8. Recommend lifting in that order
when Em greenlights slice B.

Cross-stack alignment needed with Torv before slice C+ (gaps 4-5):
the FE half of the trail (`X-Request-Id` read + interaction event
emission) is his lane. Pinging his channel after this slice ships.
