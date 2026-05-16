---
title: Getting started
section: Start here
order: 1
---

# Getting started

RedPash has two halves:

- **`backend/`** — Rust workspace (`api`, `data`, `shared` crates).
  `api` is the HTTP server; `data` is the Polars-backed compute layer;
  `shared` holds the DTOs that travel over the wire.
- **`frontend/`** — vanilla JS ES modules, no bundler. The `api` crate
  serves it via `tower_http::services::ServeDir` so `cargo run -p api`
  brings the whole app up on one port.

## Run it locally

```bash
# 1. Postgres up + DB ready
createdb redpash_dev

# 2. Backend env
cd backend
cp .env.example .env   # adjust DATABASE_URL if needed

# 3. Boot
cargo run -p api
# → listening on 0.0.0.0:8080

# 4. Open
open http://localhost:8080
```

The first thing to verify is `GET /api/health` → `{"status":"ok"}`.
If that works, the router will render `#/landing` and the rest of the
app loads from there.

The frontend has no build step in dev — edits to `frontend/**` are
picked up on reload. CSV uploads go to a default project created
under the bootstrap dev user the first time you upload.

## Phases

| Phase | Status | Scope |
|-------|--------|-------|
| 1 — Foundation                | ✅ Shipped | Cargo workspace, `/api/health`, hash router, page stubs, design tokens, service worker. |
| 2 — Cleaner                   | ✅ Shipped | `data::parse` + `data::dtype` + `data::dedup` + `data::joins` + `data::steps`, redtable, cleaning tools sidebar, undo/redo, encoding detection, join detector. See [features/cleaner.md](features/cleaner.md). |
| 3 — Reports & Dashboards      | ✅ Mostly shipped | Reports page (group-by + matrix + filter + sort + Top-N + window functions + charts panel). Dashboards (templates + chart-ref widgets). 13 chart kinds. See [features/reports.md](features/reports.md), [features/dashboards.md](features/dashboards.md), [features/charts.md](features/charts.md). |
| 4 — Auth (4a + 4b + 4c)        | ✅ Shipped | Google OAuth code flow, `rp_session` cookie, per-user data scoping via `resolve_user_rid`, per-resource ownership checks via `routes::ensure_owner` + `db::*_owner` helpers, `PATCH /api/me`, Profile + Settings pages, logout button. Dev-user fallback when OAuth env vars are unset. See [auth/google.md](auth/google.md). Share-link UI for `is_public` toggles still pending. |
| 5 — Polish & deploy           | ⬜ Pending | Bake frontend into the binary (`include_dir!`), brotli pre-compress, systemd unit, optional Maud HTML report export. |

## Project structure

```
backend/
  crates/
    api/       — Axum router, handlers, AppState, error mapping, route modules per resource
    data/      — Polars-backed compute: parse / dtype / steps / group_by / joins / dedup / encoding
    shared/    — wire DTOs (project, file, step, report, dashboard, chart, filter, …)
  migrations/  — sqlx-managed SQL (one per phase)
frontend/
  partials/    — HTML fragments per route, loaded by the router
  scripts/
    main.js              — router + page bootstrap
    api.js               — `fetch` wrapper
    cleaner/             — cleaner page modules (filter panel, tools, redtable)
    reports/             — report builder
    dashboards/          — dashboard builder + chart-render shared module + ECharts loader + widget renderers
    ui/                  — toasts, modal helpers
  styles/                — CSS tokens + per-page sheets + per-component sheets
  service-worker.js      — cache-first shell, network-first /api
docs/                    — these docs (served at /docs)
```

## Cheatsheet

- **Bump the service-worker cache** every time you push frontend changes
  (`frontend/service-worker.js` → `CACHE_VERSION = "v…"`). Otherwise the
  browser will keep serving the old shell.
- **DTOs round-trip via `serde`** — every backend change to a wire shape
  needs a matching frontend update. Adding fields with `#[serde(default)]`
  keeps older saved specs deserialising cleanly.
- **`cargo run -p api`** picks up backend changes; the frontend needs no
  rebuild but does need a hard refresh past the service worker.
- **Polars 0.43** is pinned. Some quirks documented inline: prefer
  eager `DataFrame::sort` after `group_by().agg()`; `QuantileInterpolOptions`
  (not `QuantileMethod`); `concat_str` is feature-gated in the workspace.
