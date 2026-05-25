---
title: Getting started
section: Start here
order: 1
last modified date: 2026-05-25
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
| 2 — Cleaner                   | ✅ Shipped — absorbed into Workspace | `data::parse` + `data::dtype` + `data::dedup` + `data::joins` + `data::steps`, redtable, cleaning tools sidebar, undo/redo, encoding detection, join detector. The dedicated `#/cleaner` page retired 2026-05-23 (frontend-reset); the redtable + tools now live inside `#/workspace`. |
| 3 — Object-model lock         | ✅ Shipped 2026-05-22 | Two stored entities: `Project` and `File`. Reports/Dashboards are *derived views* over `project_files WHERE file_type = 'chart' \| 'dashboard'`, not separate tables. Stage is computed (`new \| clean \| design \| publish`). See [internal/architecture/object-model.md](internal/architecture/object-model.md). |
| 4a — Google OAuth             | ✅ Shipped | Google OAuth code flow, `rp_session` cookie, dev-user fallback when env vars unset. See [auth/google.md](auth/google.md). |
| 4b — Per-user data scoping    | ✅ Shipped | `resolve_user_rid` resolver; every owner-scoped endpoint goes through it. |
| 4c — Per-resource ownership   | ✅ Shipped | `routes::ensure_owner` + `db::*_owner` helpers on every detail handler. `PATCH /api/me`, Profile + Settings pages, logout button. |
| 4d — Multi-tenancy data model | ✅ Shipped | `companies` + `company_memberships` (`owner` > `admin` > `member`), `projects.company_id` (set/re-scope), dev-permissive `/api/users` + `/api/companies` CRUD, shared-sentinel learning loop. Pending: company-scoped resource visibility (every endpoint still gates on `projects.owner_id` alone). |
| Frontend reset                | ✅ Shipped 2026-05-23 | 179 pages → 8 partials, atom catalog rewritten, audit suite. See `redtable-unification.md`. |
| Workspace milestone           | ✅ Shipped 2026-05-24 | Workspace feature-complete: pagination, joins (4 types + compound keys), filter DTO (17 ops), edit/delete via step engine, server-side filter+sort, designer + chart store. |
| Audit-everything              | ✅ Shipped 2026-05-25 | 9-tool audit suite (`auth` / `crossing` / `css` / `css-tab-compare` / `html` / `js` / `observability` / `redtable` / `rs`) + `audit.run` / `audit.finding` persistence + trend reading. See [internal/processes/audit-cadence.md](internal/processes/audit-cadence.md). |
| Cases workstream              | 🚧 In flight | Kanban + comments + activity feed dogfooding ground for customer ticket triage. See [internal/subsystems/cases.md](internal/subsystems/cases.md). Comments composer (Markdown render + small text editor) in flight. |
| 5 — Bake-binary & deploy      | ⬜ Pending | Bake frontend into the binary (`include_dir!`), brotli pre-compress, systemd unit. |
| RBAC corporate-ready          | ⬜ Pending | Row-level scoping + route gating + `/api/me` permissions payload. Schema already has `company_memberships` + `project_memberships` roles, no enforcement. |

## Project structure

```
backend/
  crates/
    api/       — Axum router, handlers, AppState, error mapping, route modules per resource (auth / me / projects / files / cases / charts / dashboards / admin / monitoring / search / events / docs / health / metrics)
    data/      — Polars-backed compute: parse / dtype / steps / group_by / joins / dedup / encoding. Pure compute, no HTTP, wasm-ready.
    shared/    — wire DTOs (project / file / step / filter / cases / admin / monitoring / search / event / …)
  migrations/  — sqlx-managed SQL (014–029 since the object-model lock)
frontend/
  partials/    — 8 HTML fragments per route (login / home / workspace / monitoring / cases / profile / settings / docs)
  scripts/
    main.js          — hash router + page bootstrap
    api.js           — `fetch` wrapper; 401 → #/login
    pages/<page>.js  — one controller per partial (8 files)
    list-page.js     — shared list-view atoms (KPI strip, composite-strip, chart cards, redtable toolbar, pager, sortable headers)
    page-row.js      — shared `.rp-page__row` template helpers (Settings + Profile)
    topbar.js        — shared topbar + omnisearch dropdown
    prefs.js         — SWR cache backed by `/api/me/prefs`
    wasm-engine.js   — lazy loader for the wasm `data` crate (landing demo + workspace preload)
    dom.js / format.js — esc + cssEsc / fmtAge / fmtTime / fmtClock / dayKey / dayLabel
    events.js        — frontend error capture → POST /api/events
  styles/                — flat per-concern sheets (no subdirs). `main.css` is the @import manifest; `tokens.css` holds `--rp-*` design tokens.
  service-worker.js      — cache-first shell, network-first /api. Bump `CACHE_VERSION` on every frontend-touching commit.
docs/                    — these docs (served at /docs/<slug>); internal team docs under `docs/internal/`
tools/                   — `*-audit/audit.js` scripts auto-discovered by `tools/audit.sh`. 9 audit tools today.
```

## Cheatsheet

- **Run `sh tools/audit.sh` before every commit.** Auto-discovers every
  `tools/*-audit/audit.js` (9 today). CSS / HTML / JS / Rust / crossing /
  redtable / observability / auth / tab-compare in one shot. `audit.run`
  + `audit.finding` persist findings; `audit.run_diff()` surfaces drift
  between runs. See [internal/processes/audit-cadence.md](internal/processes/audit-cadence.md).
- **Bump the service-worker cache** on every frontend-touching commit
  (`frontend/service-worker.js` → `CACHE_VERSION = "v…"`). Otherwise the
  browser keeps serving the old shell past hard refresh.
- **DTOs round-trip via `serde`** — every backend change to a wire shape
  needs a matching frontend update. Adding fields with `#[serde(default)]`
  keeps older saved specs deserialising cleanly.
- **`cargo run -p api`** picks up backend changes; the frontend needs no
  rebuild but does need a hard refresh past the service worker. Cleaning
  the cache via DevTools / `unregister()` if a service-worker version
  bump didn't take.
- **Polars 0.43** is pinned. Quirks documented inline: prefer eager
  `DataFrame::sort` after `group_by().agg()`; `QuantileInterpolOptions`
  (not `QuantileMethod`); `concat_str` is feature-gated in the workspace.
- **JS↔Rust boundary** is locked: Rust owns data, JS owns pixels. JS
  never implements a data engine (filter / sort / cleaning / scoring all
  live in `crates/data/`). The audit triad (js-audit + rs-audit +
  crossing-audit) enforces. See
  [internal/architecture/js-rust-boundary.md](internal/architecture/js-rust-boundary.md).
- **Commit convention**: `area: imperative summary` subject + per-file
  changelog body; sign `— <name>` at body tail. See REDMAP's
  *Conventions* section. When concurrent sessions are likely active,
  use `git commit -- <files>` or `git commit -o <pathspecs>` so
  parallel-staged WIP doesn't sweep into your commit.
