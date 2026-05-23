---
title: API routes
section: Internal
order: 21
last modified date: 2026-05-24
owner: Gus
status: filled
---

# API routes

The HTTP surface of `redpash-api`. One file per resource under
`backend/crates/api/src/routes/`, assembled in `routes/mod.rs`. This
doc is the catalog (what's exposed, where it lives, what shape it
returns) plus the middleware chain every request flows through.

Source of truth: `backend/crates/api/src/routes/mod.rs::router(state)`.

## The middleware chain

`router(state)` returns a two-layer composition: the inner `api`
Router under `/api/*`, and an outer `Router` that serves the static
frontend everywhere else.

Outermost first (each wraps everything inside it):

```
Outer router
├── TraceLayer (tower_http)           — tracing span per request
├── CorsLayer::permissive             — dev-permissive; tighten with RBAC
├── CompressionLayer                  — gzip on the way out
├── /api → API subtree (below)
└── fallback_service: ServeDir("../frontend")
                                       — serves index.html / scripts / css

API subtree (under /api/*)
├── request_id_mw                     — outermost: mint req_<uuid>, stash
│                                       in request extensions, echo on
│                                       the response as X-Request-Id
├── capture_mw                        — observes every response:
│                                       request_log::record fire-and-forget,
│                                       event::record on 4xx/5xx
├── DefaultBodyLimit::max(256 MiB)    — 256 MiB cap on request bodies
│                                       (CSV uploads are the load case)
└── nested resource Routers (below)
```

**Middleware order matters.** `request_id_mw` is outermost so the id
is set before `capture_mw` reads it; `capture_mw` wraps the body-limit
so a 413 lands in the event log too. Adding a new outer layer should
respect this — the id has to be available *and* the response has to
be observable.

See [events-and-logs](events-and-logs.md) for what `capture_mw` does
to the response.

## The route catalog

| Path prefix | Module | Routes | Auth | Notes |
|---|---|---|---|---|
| `/api/health` | `health.rs` | `GET /` | none | DB ping + uptime |
| `/api/auth` | `auth.rs` | `GET /google/start`, `GET /google/callback`, `POST /logout`, `POST /dev-login` | varies | OAuth + dev shortcut |
| `/api/me` | `me.rs` | `GET /`, `PATCH /`, `PATCH /prefs`, `GET /avatar` | session | current user; see [prefs](prefs.md) |
| `/api/users` | `users.rs` | `GET /`, `POST /`, `GET /:rid`, `PATCH /:rid`, `DELETE /:rid` | session | full user CRUD |
| `/api/companies` | `companies.rs` | `GET /`, `POST /`, `GET /:rid`, `PATCH /:rid`, `DELETE /:rid`, `GET /:rid/members`, `POST /:rid/members`, `DELETE /:rid/members/:user_id` | session | companies + memberships |
| `/api/projects` | `projects.rs` | `GET /`, `PATCH /:rid`, `DELETE /:rid`, `GET /:rid/files` | session | per-user project list |
| `/api/files` | `files.rs` | `GET /`, `POST /upload`, `GET /:rid`, `PATCH /:rid`, `DELETE /:rid`, `GET /:rid/page`, `POST /:rid/steps`, `POST /:rid/cast-preview`, `POST /:rid/undo`, `POST /:rid/redo`, `POST /:rid/clear-filters`, `POST /:rid/encoding`, `GET /:rid/dedup`, `GET /:rid/joins`, `POST /:rid/joins`, `POST /:rid/snapshot`, `GET /:rid/uniques`, `GET /:rid/sentinels` | session, owner-scoped | the data-engine surface |
| `/api/charts` | `charts.rs` | `GET /`, `POST /`, `GET /:rid`, `PUT /:rid`, `DELETE /:rid` | session | chart-typed `project_files` |
| `/api/dashboards` | `dashboards.rs` | `GET /`, `POST /`, `GET /:rid`, `PUT /:rid`, `PATCH /:rid`, `DELETE /:rid`, `POST /:rid/favorite` | session | dashboard-typed `project_files` |
| `/api/group` | `group.rs` | `POST /preview` | session | group-by aggregation; powers Reports |
| `/api/events` | `events.rs` | `GET /`, `POST /` (frontend report), `GET /:rid` | session for GET, anon for POST | runtime observability log |
| `/api/metrics` | `metrics.rs` | `GET /` | session | perf KPI strip over `request_log` |
| `/api/monitoring` | `monitoring.rs` | `GET /events`, `GET /requests`, `GET /requests/stats`, `GET /audit-runs`, `GET /audit-findings` | session | the `/monitoring` page surface |
| `/api/admin` | `admin.rs` | `GET /users`, `GET /users/stats`, `GET /companies`, `GET /companies/stats`, `GET /memberships`, `GET /memberships/stats`, `GET /files`, `GET /files/stats`, `GET /charts`, `GET /charts/stats`, `GET /steps`, `GET /steps/stats` | session (RBAC-gated when it lands) | Home rail org/data tabs |
| `/api/search` | `search.rs` | `GET /` | session | omnisearch backing the topbar |
| `/api/demo` | `demo.rs` | `POST /parse` | none | landing-page CSV demo |
| `/api/docs` | `docs.rs` | `GET /`, `GET /*slug` | none | renders `docs/` MD tree |

## Auth resolution

`me::resolve_user_rid(state, headers) -> Result<String, AppError>`
is the shared helper every owner-scoped endpoint uses to find the
calling user. Resolution order:

1. **Session cookie** (`rp_session`) → `db::find_session_user` → user RID.
2. **No session, OAuth disabled (dev mode)** → fall back to
   `state.dev_user` (set at bootstrap by `state::AppState::init`).
3. **No session, OAuth enabled** → `401 unauthenticated`.

Routes that need ownership enforcement layer
`ensure_owner(owner_lookup, expected, label, rid)` on top — returns
`404 not_found` on a miss or mismatch, never leaking the
"exists-but-not-yours" vs "doesn't exist" distinction.

## Adding a new resource

1. Create `backend/crates/api/src/routes/<name>.rs` with
   `pub fn routes() -> Router<AppState> { Router::new().route(...) }`.
2. Add `mod <name>;` to `routes/mod.rs` (keep the alphabetical block).
3. Add `.nest("/<name>", <name>::routes())` to the `api` chain in
   `router(state)`. Order doesn't matter (axum routes are matched on
   prefix, not declaration order), but stick to the existing rail
   for readability.
4. If the resource needs owner scoping: `resolve_user_rid` →
   `ensure_owner` per handler.
5. If the resource exposes list endpoints: return `shared::Page<T>`
   so the frontend's existing redtable / LIST_VIEWS consumer pattern
   works without bespoke wiring. See [admin-monitoring-surfaces](../specs/admin-monitoring-surfaces.md) §6.
6. If the resource returns errors with a stable kind, use
   `AppError::not_found("invalid_csv", …)` / `bad_request` / etc.
   The kind shows up in the event log via `capture_mw`'s
   `EventInfo` extension — that's how monitoring → Events groups
   failures by category.

## What does NOT live in a route module

- **Long-running side effects** — `event::record` and
  `request_log::record` are fire-and-forget tokio spawns. Wrap
  yours similarly; the request path must never block on a write
  that doesn't change the response.
- **Auth / session lifecycle** — `routes::auth` mints + revokes
  the cookie; `routes::me` reads it. Don't validate sessions ad-
  hoc inside a resource module; use `resolve_user_rid`.
- **DB queries that mix concerns** — long SQL strings live in
  `backend/crates/api/src/db.rs` so route handlers stay the
  "shape + auth + error mapping" layer. See [data-engine](data-engine.md).

## Cross-cuts

- **Compression**: gzipped responses for everything via the outer
  `CompressionLayer`. The wasm engine relies on this — 11.5 MB raw
  binary delivers as ~3.3 MB over the wire. See
  [wasm-engine](wasm-engine.md).
- **CORS**: `CorsLayer::permissive` in dev. Tightens at the same
  time RBAC lands.
- **Tracing**: every request gets a `tracing` span via `TraceLayer`.
  The `request_id` is in scope via the request extension; emit
  `tracing::info_span!(…, request_id = %req_id)` if you want it on
  every log line for a handler.
- **Body limit**: 256 MiB. Above Salesforce's 100 MB CSV import cap,
  and Polars handles arbitrary row/column counts internally. A 413
  *is* captured into the event log (the body-limit layer is inside
  capture_mw) — useful for spotting CSVs that exceeded the cap.

## Rust internals — middleware composition + the helpers

### Middleware ordering — `router(state)` walk

```rust
pub fn router(state: AppState) -> Router {
    let capture_state = state.clone();

    let api = Router::new()
        .nest("/health",   health::routes())
        .nest("/me",       me::routes())
        // ... 15 more .nest() calls
        .nest("/docs",     docs::routes())
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(axum::middleware::from_fn_with_state(capture_state, capture_mw))
        .layer(axum::middleware::from_fn(request_id_mw));

    let frontend = ServeDir::new("../frontend").append_index_html_on_directories(true);

    Router::new()
        .nest("/api", api)
        .fallback_service(frontend)
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
```

**Layer ordering in axum**: `.layer()` *wraps* — the last
`.layer()` declared is the outermost (runs first on request,
last on response). So the actual nesting from outside in:

```
TraceLayer                  ← outermost (request enters here)
  CorsLayer
    CompressionLayer
      [/api router]
        request_id_mw       ← API subtree outermost
          capture_mw
            DefaultBodyLimit
              [resource routers]   ← .with_state(state) finalizes here
```

**Why `state.clone()` for capture_mw**: `.with_state(state)`
consumes `state`. The middleware needs its own clone to access
the pool. `AppState` is `Arc`-wrapped internally (DashMap, Arc'd
pool), so the clone is a few ref-bumps; cheap.

### `request_id_mw` — minimal hot-path work

```rust
#[derive(Clone)]
struct RequestId(String);

async fn request_id_mw(mut req: Request, next: Next) -> Response {
    let rid = format!("req_{}", uuid::Uuid::new_v4().simple());
    req.extensions_mut().insert(RequestId(rid.clone()));
    let mut resp = next.run(req).await;
    if let Ok(hv) = HeaderValue::from_str(&rid) {
        resp.headers_mut().insert("x-request-id", hv);
    }
    resp
}
```

**Per-request cost**: one `Uuid::new_v4()` (~100ns), one
`format!`, one extension insert, one header insert. Sub-µs.

**`req_` prefix** to namespace from RIDs (`USR_`, `FIL_`, etc.).
Distinguishable at a glance in logs; doesn't collide with the
real RID format.

**`.simple()`** strips the dashes from the UUID's default
display. Shorter on the wire (`req_abcd...` vs `req_abcd-...`);
no semantic difference.

### `resolve_user_rid` — three-branch auth

```rust
pub async fn resolve_user_rid(state: &AppState, headers: &HeaderMap)
    -> Result<String, AppError>
{
    if let Some(sid) = super::read_cookie(headers, "rp_session") {
        if let Some(uid) = db::find_session_user(&state.db, &sid).await
            .map_err(|e| AppError::internal("db", e.to_string()))?
        {
            return Ok(uid);
        }
    }
    if state.oauth.is_some() {
        return Err(AppError {
            status:  StatusCode::UNAUTHORIZED,
            kind:    "unauthenticated",
            message: "no session cookie".into(),
        });
    }
    Ok(state.dev_user.as_ref().clone())
}
```

**Resolution order**:

1. **Has session?** Look up user; success → return.
2. **No session OR session invalid + OAuth configured** → 401.
3. **No session + OAuth disabled (dev mode)** → fallback to the
   bootstrap `dev_user`.

The fallback exists because solo-dev on localhost doesn't always
have OAuth configured. The `state.oauth.is_some()` check is the
deciding factor: when OAuth is configured (production-ish),
demand a session; otherwise the dev fallback is the right call.

**`find_session_user` is one indexed lookup** on `sessions`
table by RID. ~1ms steady-state. Called on every authed endpoint
hit, so the DB pool's connection management matters: today's
pool has 5-10 connections (state::AppState::init sets it), enough
to absorb the boot burst.

### `ensure_owner` — 404 instead of 403

```rust
pub(crate) fn ensure_owner(
    owner_lookup: Result<Option<String>, sqlx::Error>,
    expected:     &str,
    label:        &str,
    rid:          &str,
) -> Result<(), crate::error::AppError> {
    let owner = owner_lookup
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("{label} {rid}")))?;
    if owner != expected {
        return Err(AppError::not_found("not_found", format!("{label} {rid}")));
    }
    Ok(())
}
```

**404 on mismatch, not 403** — deliberately doesn't leak
"this exists but isn't yours" vs "this doesn't exist." A 403
would tell an attacker the RID is valid (just not theirs); a
404 keeps the existence private.

**`label` parameter** for the error message — `"file"`,
`"project"`, `"chart"` — so the response reads `"file FIL_… not
found"`. The same helper serves every resource.

### `capture_mw` — see [events-and-logs](events-and-logs.md)

The full body and the percentile_cont SQL backing /api/metrics
live in the events-and-logs subsystem doc. Cross-reference rather
than duplicate.

## Optimization map

| Phase | Cost | Optimization horizon |
|---|---|---|
| `request_id_mw` per request | ~1 µs | n/a |
| `capture_mw` pre-handler snapshot | ~1 µs (route_normalize) | n/a |
| Handler dispatch (axum's router) | ~µs match | n/a |
| `resolve_user_rid` (per authed call) | ~1ms session lookup | cached session map (in-memory) at scale |
| `ensure_owner` (per resource access) | ~1ms ownership query | combine with the resource hydrate to save the extra trip when both fire |
| `capture_mw` post-handler write | spawn (~µs) + async insert | fire-and-forget; no foreground cost |

**Auth resolution is the most-called DB hit** in the system.
At ~1ms × 100 req/s = 100ms/s of DB work. Today's pool absorbs
it; if connection count ever becomes a bottleneck, the right
fix is an in-memory session cache (`(session_rid, user_rid)` map
with TTL ≈ session expiry). Out of scope today.
