---
title: Events and logs
section: Internal
order: 24
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Events and logs

RedPash captures two distinct streams that together back the
`/monitoring` page:

| Stream | What it records | Granularity | Table |
|---|---|---|---|
| **events** | semantic — *what happened* (HTTP error, auth event, step apply, frontend JS exception, …) | one row per discrete occurrence | `public.events` |
| **request_log** | mechanical — *every HTTP request* | one row per `/api/*` request | `public.request_log` |

Both are append-only, fire-and-forget, and intentionally cheap to
write. Observation must never slow or fail the thing it's observing.

Source of truth: `backend/crates/api/src/event.rs`,
`backend/crates/api/src/request_log.rs`,
`backend/crates/api/src/routes/{events,monitoring,metrics}.rs`,
`frontend/scripts/events.js`.

## The two streams in one sentence

- **request_log**: did the request happen, and how long did it take?
- **events**: was anything *worth knowing* about it?

A successful request lands in request_log with no event. A 500
lands in *both* — one as the request, one as the error context. A
frontend `try/catch` `reportEvent` call lands only in events. A
backend auth flow milestone (`event::record({ kind:
"auth_login_success" })`) lands only in events.

## events — the semantic log

Schema details in [monitoring-schemas](../specs/monitoring-schemas.md) §1.
Highlights:

- RID prefix `EVT_`.
- `origin = "backend" | "frontend"` (the only legal values, by CHECK).
- `level = "debug" | "info" | "warn" | "error"`.
- `kind` is a free-form string (e.g. `http_error`, `auth_login`,
  `step_apply`, `pref_change`-future, …) — the dispatch key for
  monitoring filters.
- `context` JSONB carries the structured payload — kind-specific
  shape; the consumer reads the kind first, then the context.
- `request_id` correlates one HTTP request's events across
  backend + frontend (see "Correlation" below).

### Write paths

There are exactly three sites that write to `events`:

**1. `capture_mw` — auto-record any HTTP error.**

The middleware (`routes::capture_mw`) observes every `/api/*`
response. On a 4xx/5xx status:

```rust
event::record(&state.db, EventDraft {
    origin:      "backend",
    level:       if status >= 500 { "error" } else { "warn" },
    kind:        "http_error",
    message:     err_kind_or_canonical_status,
    user:        resolve_from_session_cookie,   // best-effort, only on error path
    session_id:  read_cookie("rp_session"),
    request_id:  ext.get::<RequestId>(),
    http_method: Some(method),
    http_path:   Some(path),
    http_status: Some(status as i32),
    duration_ms: Some(elapsed_ms),
    context:     { "error_kind": <AppError.kind> } or {},
    ..Default::default()
});
```

The error's `kind` (set by `AppError::*` constructors) flows
through to `events.context.error_kind` via an `EventInfo` extension
attached to the response by `AppError::into_response`. Responses
without it (axum's own 404/405, the body-limit 413, JSON-extractor
400s) record by status alone.

**2. `event::record(pool, EventDraft)` — direct backend calls.**

Lifecycle events that aren't HTTP errors. The current sites:

| Site | Kind | When |
|---|---|---|
| `routes::auth::callback` | `auth_login_success` / `auth_login_failed` | Google OAuth callback success / failure |
| (planned) `routes::files::add_step` | `step_apply` | Step engine failures on the apply path |

Add a new direct write whenever something deserves its own kind in
the monitoring Events tab — generally state transitions and
recoverable failures the user should be able to ask about.

**3. `POST /api/events` — frontend reports.**

`frontend/scripts/events.js::installErrorCapture()` is called
before any other module at the top of `main.js`. It wires:

- `window.onerror` and `window.onunhandledrejection` → POST with
  `{ origin: "frontend", level: "error", kind: "js_error", message,
  source, context: { stack, line, col, … } }`.
- `reportEvent({ level, kind, message, source?, context? })` —
  the explicit helper any page can call to record a non-exception
  event (e.g. *demo upload rejected by gateBySize* → `kind:
  "demo_oversize"`).

Body shape: `shared::event::EventReport`. Server hydrates `origin =
"frontend"`, `user_redpash_id` + `session_id` from the request
cookie (never trusted from the body), and the unsupplied fields
default. The endpoint always returns 204 — a logging endpoint must
never cause the caller to retry.

### Read paths

| Path | Shape | Use |
|---|---|---|
| `GET /api/events?level&kind&limit` | flat list (legacy) | Per-rid drill-down / direct queries |
| `GET /api/events/:rid` | full `Event` (incl. context) | Detail view |
| `GET /api/monitoring/events?page&size&window&level&kind` | `Page<EventSummary>` | Monitoring → Events tab — paginated, window-filtered |

`EventSummary` omits `context`, `user_redpash_id`, `session_id`,
`http_method`, `http_path`, `duration_ms` — those land in the per-
rid detail view. Pattern matches every other admin/monitoring
list endpoint.

## request_log — the mechanical capture layer

Schema details in [monitoring-schemas](../specs/monitoring-schemas.md) §2.

Every `/api/*` request gets one row written by `capture_mw` via
`request_log::record(…)`. Fields:

- `at` — request timestamp.
- `method` / `route` — `route` is the *normalized* path (see below).
- `status` / `duration_ms`.
- `request_id` — correlates back to any `events` row from the same
  request.

### Route normalization

`request_log::normalize_route(path)` collapses RedPash-ID segments
(`<2-4 uppercase letters>_<32 hex>`) to `:id` so `/files/FIL_.../page`
aggregates as one route — otherwise per-file traffic would
fragment the per-route stats.

**Stored values are post-`/api`-strip** because `capture_mw` layers
on the *nested* api router, where axum has already stripped the
prefix. So `/api/projects` lands as `/projects` in the table; the
`/api/monitoring/*` endpoints filter their own traffic with
`route NOT LIKE '/monitoring%'`. This subtlety is documented at
every filter call site and at [monitoring-schemas §7](../specs/monitoring-schemas.md#7-self-observation-filter).

### Read paths

| Path | Shape | Use |
|---|---|---|
| `GET /api/metrics?window=` | overall KPIs + per-route ranked | Top KPI strip on the monitoring Requests tab |
| `GET /api/monitoring/requests?page&size&window&route&status&method` | `Page<RequestSummary>` | Paginated drill-down redtable |
| `GET /api/monitoring/requests/stats?window=` | `{ window, total, status_mix, top_routes }` | Status-mix donut + p95-ranked routes panel |

Self-observation is filtered out (`route NOT LIKE '/monitoring%'`
on the monitoring endpoints, `'/metrics'` on the metrics endpoint)
so opening the page doesn't pollute its own data.

Percentiles use Postgres' `percentile_cont(0.50|0.95|0.99) WITHIN
GROUP (ORDER BY duration_ms)`. Cast to `BIGINT` (sub-ms is noise on
captured int-ms latencies).

## Correlation — `request_id` is the join key

Every request gets `req_<uuid>` minted by `request_id_mw` (the
outermost `/api` middleware). The id:

- Lives in the request extension so `capture_mw` reads it without
  re-parsing headers.
- Echoes on the response as `X-Request-Id` so the frontend can
  stamp its own events with the same id (`api.js` reads the header
  and threads it into any `reportEvent` call from that page tick).
- Lands on both `events.request_id` and `request_log.request_id`,
  letting a query stitch the two streams:

```sql
SELECT r.at, r.method, r.route, r.status, r.duration_ms,
       e.level, e.kind, e.message
  FROM request_log r
  LEFT JOIN events e ON e.request_id = r.request_id
 WHERE r.request_id = $1
 ORDER BY e.occurred_at;
```

## What "expected noise" looks like

When you load `/api/metrics` and see numbers like *17% error rate
on /me* or *24 401s in the 24h window*, that's almost always the
anon-polling baseline:

- Every fresh page load hits `GET /api/me` once before the user
  signs in (the topbar + boot flow check session).
- That call returns 401 when OAuth is enabled and no session
  cookie is present — by design, not a bug.

So *401s on /me* and *401s on /projects* are background noise.
Treat **5xx**, **3xx that aren't OAuth redirects**, and any 4xx on
authenticated routes as actionable signal. `routes::auth::callback`
emits a `kind="auth_login_success"` event on the happy path, so
filtering events to `kind != http_error` surfaces real lifecycle
moments without the noise.

## Retention + cost

Both tables are append-only and unbounded today. No archive job,
no TRUNCATE on a schedule. Per-row cost is low (a few hundred
bytes); at solo-dev / pre-prod scale, growth is negligible. When
production multi-tenancy ships, a retention policy lands:

- `request_log` — TRUNCATE rows older than 90 days nightly
  (request-by-request granularity matters short-term, not for
  audit).
- `events` — keep forever (the audit/troubleshooting story relies
  on history).

Until then: don't bake a retention assumption into a consumer.

## Cross-cuts

- **Both streams are fire-and-forget.** Every write site wraps the
  insert in `tokio::spawn` so the request path never waits on the
  log. A DB failure on the log path emits `tracing::warn` and
  drops the row — the foreground response is unaffected.
- **No PII guardrails beyond user_redpash_id.** Don't put email
  addresses, API tokens, or raw user input into `events.message` /
  `context`. The monitoring page is internal today, but the
  retention story above + the future RBAC story will surface this
  to non-admins.
- **Frontend's `reportEvent` is the only way to write from the
  client.** No direct INSERT, no SQL exposure — the API gate
  enforces the `origin = "frontend"` rule + the session-stamping.
- **WS#5 redtable unification consumes both.** Today's monitoring
  page renders four kind-specific list tabs; the redtable
  unification lands one renderer (per [architecture/redtable-unification](../architecture/redtable-unification.md))
  that reads `Page<T>` from any of the list endpoints. No backend
  change needed — `Page<T>` consistency was the whole point.

## Rust internals — `capture_mw` + `event::record` + percentile_cont

### `capture_mw` end-to-end

```rust
async fn capture_mw(
    State(state): State<AppState>,
    req:          Request,
    next:         Next,
) -> Response {
    let method  = req.method().to_string();
    let path    = req.uri().path().to_string();
    let route   = crate::request_log::normalize_route(&path);
    let req_id  = req.extensions().get::<RequestId>().map(|r| r.0.clone());
    let session = read_cookie(req.headers(), "rp_session");

    let started = Instant::now();
    let resp = next.run(req).await;
    let status = resp.status();
    let ms = started.elapsed().as_millis() as i32;

    // Stream 1 — request_log: fire-and-forget tokio::spawn inside record()
    crate::request_log::record(
        &state.db, method.clone(), route, status.as_u16() as i16, ms,
        req_id.clone(),
    );

    // Stream 2 — events: only on 4xx/5xx
    if status.as_u16() >= 400 {
        let (err_kind, message) = match resp.extensions().get::<crate::event::EventInfo>() {
            Some(info) => (Some(info.kind), info.message.clone()),
            None       => (None, status.canonical_reason().unwrap_or("error").to_string()),
        };
        let level = if status.as_u16() >= 500 { "error" } else { "warn" };
        let context = match err_kind {
            Some(k) => serde_json::json!({ "error_kind": k }),
            None    => serde_json::json!({}),
        };
        // Best-effort user lookup on the error path
        let user = match &session {
            Some(sid) => crate::db::find_session_user(&state.db, sid).await.ok().flatten(),
            None      => None,
        };
        crate::event::record(&state.db, crate::event::EventDraft {
            origin: "backend", level, kind: "http_error".into(),
            message, user, session_id: session,
            request_id: req_id, http_method: Some(method),
            http_path: Some(path), http_status: Some(status.as_u16() as i32),
            duration_ms: Some(ms), context, ..Default::default()
        });
    }
    resp
}
```

**Lifecycle order**:

1. **Pre-handler**: read method + path + session cookie + request_id;
   snapshot `Instant::now()`. The route normalization runs *now*
   (against the path the handler will see) so request_log captures
   the same shape as monitoring's filters.
2. **Run handler** via `next.run(req).await`.
3. **Post-handler**: read response status + extensions.
4. **request_log insert** — fires for *every* request, success or
   failure. Inside `record()`, a `tokio::spawn` decouples the
   write from the response path.
5. **events insert** — only if `status >= 400`. Best-effort user
   lookup (extra DB call only on the error path, so cheap-by-frequency).

**`EventInfo` extension**: `AppError::into_response` attaches an
`EventInfo { kind, message }` to the response extensions. The
middleware reads it back to populate `events.context.error_kind`
+ `events.message`. Responses without an `EventInfo` (axum's own
404/405, the body-limit 413, JSON-extractor 400s) record with
`context = {}` + the canonical HTTP status reason as message.

### `event::record` — the fire-and-forget pattern

```rust
pub fn record(pool: &PgPool, draft: EventDraft<'_>) {
    let pool = pool.clone();
    let draft = draft.into_owned();
    tokio::spawn(async move {
        if let Err(e) = insert_event(&pool, draft).await {
            tracing::warn!(error = %e, "event insert failed (non-fatal)");
        }
    });
}
```

**Why not `async fn`**: the foreground request response is
already returned by the time this runs. A failing insert
shouldn't propagate. The pattern is **"observe + drop"**: the
event is best-effort; if the DB is down, we log the warn and
move on. The user's request still succeeded (or failed) on its
own merits.

**Cost per call**: one `pool.clone()` (Arc bump) + one
`tokio::spawn` (cheap on a multi-threaded runtime). Insert
itself is one INSERT + indexes touched. At 10k requests/day the
events table grows by ~500 rows (assuming the typical 5% error
rate); negligible row count.

### `request_log::record` — same fire-and-forget shape

```rust
pub fn record(pool: &PgPool, method: String, route: String,
              status: i16, duration_ms: i32, request_id: Option<String>) {
    let pool = pool.clone();
    tokio::spawn(async move {
        if let Err(e) = sqlx::query(
            "INSERT INTO request_log (method, route, status, duration_ms, request_id)
             VALUES ($1, $2, $3, $4, $5)")
            .bind(method).bind(route).bind(status).bind(duration_ms).bind(request_id)
            .execute(&pool).await
        {
            tracing::warn!(error = %e, "request_log insert failed (non-fatal)");
        }
    });
}
```

Identical shape to `event::record`. Same warn-and-drop semantics.

### `normalize_route` — collapsing RIDs

```rust
pub fn normalize_route(path: &str) -> String {
    path.split('/').map(|seg| {
        if is_redpash_id(seg) { ":id" } else { seg }
    }).collect::<Vec<_>>().join("/")
}

fn is_redpash_id(seg: &str) -> bool {
    match seg.split_once('_') {
        Some((prefix, hex)) => {
            (2..=4).contains(&prefix.len())
                && prefix.bytes().all(|b| b.is_ascii_uppercase())
                && hex.len() == 32
                && hex.bytes().all(|b| b.is_ascii_hexdigit())
        }
        None => false,
    }
}
```

**Algorithm**: split on `/`, check each segment against the RID
shape (`<2-4 uppercase letters>_<32 hex>`). Collapses match → `:id`.

Cost: O(n_segments × seg_len). Path lengths cap at a few hundred
chars; this runs once per request inside the hot middleware path
and contributes ~1 µs.

**Why explicit "is this a RID" check instead of regex**: regex
crate dependency adds ~200 KB to the binary; the byte-level check
is just as fast and zero-dep. The RID format is locked
(documented in `docs/db/redpash-id.md`), so the shape check
won't drift.

## SQL internals — `percentile_cont` for /api/metrics

The metrics endpoint computes p50/p95/p99 per route using
Postgres' built-in percentile aggregator:

```sql
SELECT method, route,
       COUNT(*)::BIGINT                                                              AS cnt,
       COUNT(*) FILTER (WHERE status >= 400)::BIGINT                                 AS errs,
       COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p50,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p95,
       COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p99
  FROM request_log
 WHERE at >= $1
   AND route NOT LIKE '/metrics%'
 GROUP BY method, route
 ORDER BY cnt DESC;
```

**`percentile_cont` vs `percentile_disc`**: continuous (cont)
interpolates between values when the percentile falls between
two samples; discrete (disc) picks the nearest actual value.
For latency in ms, interpolation is the right call —
"the boundary at p95" isn't a real request, it's the threshold.

**`COALESCE(…, 0)`**: an empty window returns NULL from
percentile_cont. Coalescing to 0 keeps the response shape stable
(never NULL in the JSON). Tradeoff: a literally-empty window
reads "0ms p95" which could be misread as "lightning fast";
acceptable because the `count` is also 0 in the same row, so the
operator knows to look at count first.

**Cast to BIGINT**: percentile_cont returns DOUBLE PRECISION;
the wire shape uses i64. Sub-millisecond resolution would be
noise on captured int-ms latencies, so truncating is fine.

**Index support**: `request_log_route_idx` is
`(route, at DESC)`. The WHERE clause hits it; the GROUP BY
walks all matching rows. Postgres' planner picks an index scan
+ in-memory hash aggregate for typical window sizes.

### Status-mix donut

```sql
SELECT status::TEXT AS status_str, COUNT(*)::BIGINT AS cnt
  FROM request_log
 WHERE at >= $1
   AND route NOT LIKE '/monitoring%'
 GROUP BY status
```

**Cast status to TEXT** so the frontend keys the JSON object by
string (`"200"`, `"401"`, …) instead of integer keys (JSON
allows them but the donut renderer expects strings). One-pass
GROUP BY; trivially indexed.

## Optimization map — where the cost lives

| Phase | Cost | Optimization horizon |
|---|---|---|
| `capture_mw` per request | ~1 µs route-normalize + spawn (queue insert) | n/a — already minimal |
| `event::record` per error | spawn + INSERT (~5ms tail) | the actual DB write is the cost, decoupled from request response |
| `request_log::record` per request | spawn + INSERT (~3ms tail) | same — every request takes this hit asynchronously |
| `percentile_cont` per route | O(rows in window) — index-scan + hash-aggregate | indexed; bottleneck would be N_routes for very chatty servers (today: tens of routes) |
| `audit.run_diff(cur, prev)` per ingest | O(findings_per_run) — set ops in SQL | linear; today's runs have a few hundred findings max |

**The dominant cost at scale** would be `request_log`
unboundedness — every request is one row, no retention. A 100
req/s server adds ~8M rows/day. The table doesn't break at that
size but the per-route GROUP BY slows. A retention policy
(`DELETE WHERE at < now() - interval '90 days'` nightly) holds
the table size constant; not built today.

`events` is the other unbounded table but writes are 100× less
frequent (only on errors + explicit lifecycle calls); growth is
negligible for years at solo-dev scale.
