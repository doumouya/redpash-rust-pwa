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
