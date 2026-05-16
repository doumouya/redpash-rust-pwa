---
title: REDMAP — find anything fast
section: Start here
order: -1
---

# RedPash REDMAP

One page index for navigating the Rust + vanilla-JS app without `grep`.
Sections: [Surface map](#surface-map) · [Objects](#objects) · [Screens](#screens) · [Systems](#systems) · [API](#api-quick-reference) · [Files](#files-cheatsheet) · [Conventions](#conventions--gotchas)

---

## Surface map

```
redpash-app/
├── backend/
│   ├── Cargo.toml                          ← workspace pins (polars 0.43, axum 0.7, sqlx 0.8)
│   ├── .env / .env.example                 ← DATABASE_URL, REDPASH_*, GOOGLE_OAUTH_*
│   ├── crates/
│   │   ├── api/                            HTTP server (Axum). One route module per resource.
│   │   │   └── src/
│   │   │       ├── main.rs                 boot, tracing, Postgres pool, bind
│   │   │       ├── state.rs                AppState — db pool, FileEntry cache, OAuthConfig, http client
│   │   │       ├── bootstrap.rs            idempotent dev_user + default project on first run
│   │   │       ├── id.rs                   RedPash-ID generator (`PFX_<32 uppercase hex>`)
│   │   │       ├── db.rs                   SQL helpers — every query lives here
│   │   │       ├── error.rs                AppError + IntoResponse + From<DataError>
│   │   │       └── routes/
│   │   │           ├── mod.rs              Router assembly + ServeDir + `ensure_owner` helper
│   │   │           ├── auth.rs             Google OAuth — /start, /callback, /logout
│   │   │           ├── me.rs               GET + PATCH /api/me + resolve_user_rid (shared)
│   │   │           ├── health.rs           liveness
│   │   │           ├── projects.rs         list + per-project file list
│   │   │           ├── files.rs            upload, page, steps, undo/redo, joins, snapshots
│   │   │           ├── reports.rs          CRUD + /preview + /run + favorite
│   │   │           └── dashboards.rs       CRUD + favorite
│   │   ├── data/                           Polars-backed compute. No HTTP.
│   │   │   └── src/
│   │   │       ├── parse.rs                CSV → DataFrame; apply_filter; date helpers
│   │   │       ├── dtype.rs                column summaries
│   │   │       ├── steps.rs                replay applied steps; dispatch by kind
│   │   │       ├── group_by.rs             report engine — group/agg/sort/top_n/windows
│   │   │       ├── joins.rs                overlap-coefficient detector
│   │   │       ├── dedup.rs                full-row + per-PK dedup
│   │   │       └── encoding.rs             chardetng wrapper + BOM-first
│   │   └── shared/                         DTOs travelling over the wire
│   │       └── src/
│   │           ├── project.rs              ProjectSummary
│   │           ├── file.rs                 FileSummary, ColumnMeta, PageQuery
│   │           ├── step.rs                 ProjectStep, StepRequest
│   │           ├── filter.rs               FilterNode (Group/Leaf), FilterOp, FilterSpec
│   │           ├── report.rs               Report, ReportSpec, Aggregation, AggFn, SortSpec, TopNFilter, WindowSpec, ChartSpec
│   │           ├── dashboard.rs            Dashboard, DashboardSpec, Widget
│   │           └── user.rs                 UserProfile
│   └── migrations/                         sqlx-managed SQL — one per phase
│
├── frontend/
│   ├── index.html                          shell
│   ├── service-worker.js                   cache-first shell, network-first /api. Bump CACHE_VERSION on FE changes!
│   ├── partials/                           HTML per route, loaded by router
│   ├── styles/
│   │   ├── main.css                        :root tokens (--rp-*), reset, shell, dark-mode
│   │   ├── components/                     buttons / topbar / toast / modal / filters / redtable / forms
│   │   └── pages/                          per-page sheets (cleaner.css, reports.css, dashboards.css)
│   └── scripts/
│       ├── main.js                         hash router + page bootstrap
│       ├── api.js                          fetch wrapper; 401 → #/landing
│       ├── ui/
│       │   ├── toast.js                    success/error/info toasts
│       │   └── history.js                  generic undo/redo ring buffer (reports + dashboards)
│       ├── cleaner/                        cleaner controller + filter panel + tools sidebar
│       ├── reports/index.js                report builder (charts panel + tools panel)
│       ├── dashboards/
│       │   ├── index.js                    dashboard builder (template + slots)
│       │   ├── widgets.js                  chart-ref and text widget renderers
│       │   ├── templates.js                grid template registry
│       │   ├── echarts.js                  lazy loaders (loadECharts + loadECStat)
│       │   └── chart-render.js             shared chartOption + per-kind extractors. Used by reports AND dashboards.
│       └── pages/                          one-liners that mount each page module
│
└── docs/                                   served at /docs (this file lives here)
    ├── REDMAP.md (this)                    one-page navigation
    ├── INDEX.md                            section TOC
    ├── getting-started.md                  run locally, phase progress
    ├── features/                           cleaner, joins, reports, dashboards, charts
    ├── objects/                            DTO reference (report, dashboard, chart)
    ├── api/                                per-resource detail (overview + health/me/auth/projects/files/reports/dashboards)
    ├── auth/google.md                      OAuth flow + cookies + dev_user fallback
    ├── db/schema.md                        tables + migrations + RID prefixes
    ├── dev/setup.md                        prereqs, watch loop
    └── frontend/design.md                  tokens, dark mode, naming convention vs library
```

---

## Objects

### User (`UserProfile`)
| Layer | Location |
|---|---|
| **DTO** | `shared::user::UserProfile` |
| **Table** | `users` (migration 001) — adds `google_sub` in migration 006 |
| **RID prefix** | `USR` |
| **DB helpers** | `db::find_user_by_id`, `find_user_by_username`, `find_user_by_google_sub`, `insert_user`, `upsert_google_user`, `update_user` (sparse merge + jsonb-merge for `prefs`), `ensure_default_project` |
| **API** | `GET /api/me`, `PATCH /api/me` (sparse update of profile fields + shallow merge of `prefs`) |
| **Resolver** | `routes::me::resolve_user_rid(state, headers)` — single source of truth, re-exported from `routes::mod` |
| **Ownership helper** | `routes::ensure_owner(lookup, expected_user, label, rid)` — re-exported from `routes::mod`, called by every detail handler |
| **Docs** | [`auth/google.md`](auth/google.md), [`api/me.md`](api/me.md) |

### Session
| Layer | Location |
|---|---|
| **Table** | `sessions` (migration 006) |
| **RID prefix** | `SES` |
| **Cookie** | `rp_session` (HttpOnly, SameSite=Lax, 30 days) |
| **DB helpers** | `db::create_session`, `find_session_user` (auto-deletes expired), `delete_session` |
| **API** | `GET /api/auth/google/start`, `GET /api/auth/google/callback`, `POST /api/auth/logout` |
| **Code** | `routes::auth` |

### Project (`ProjectSummary`)
| Layer | Location |
|---|---|
| **DTO** | `shared::project::ProjectSummary` |
| **Table** | `projects` (migration 001). Unique partial index for `is_default`. |
| **RID prefix** | `PRJ` |
| **DB helpers** | `db::list_projects(owner)`, `find_default_project`, `insert_project`, `ensure_default_project`, `project_owner` (ownership gate) |
| **API** | `GET /api/projects`, `GET /api/projects/:rid/files` (owner-gated) |
| **Frontend** | `partials/home.html` lists; cleaner page uses default project for upload landing |

### File (`FileSummary`)
| Layer | Location |
|---|---|
| **DTO** | `shared::file::FileSummary`, `ColumnMeta`, `PageQuery` |
| **Table** | `project_files` (migration 001) |
| **RID prefix** | `FIL` |
| **Storage** | `<REDPASH_DATA_DIR>/files/<rid>.bin` (raw bytes) |
| **In-memory** | `AppState.files: DashMap<rid, FileEntry { summary, columns, frame: Arc<DataFrame> }>` |
| **DB helpers** | `db::insert_file`, `find_file`, `list_files_in_project`, `file_owner` (ownership gate) |
| **API** | `POST /api/files/upload`, `GET /:rid`, `GET /:rid/page`, `POST /:rid/{steps,undo,redo,encoding,snapshot,joins}`, `GET /:rid/{dedup,joins,uniques}` |
| **Hydrate** | `routes::files::hydrate(state, rid)` — used by reports too |
| **Frontend** | `scripts/cleaner/index.js` controller; `partials/cleaner.html` |

### Step (`ProjectStep`)
| Layer | Location |
|---|---|
| **DTO** | `shared::step::ProjectStep`, `StepRequest` |
| **Table** | `project_steps` |
| **RID prefix** | `STP` |
| **DB helpers** | `db::list_steps`, `insert_step`, `undo_last`, `redo_next` |
| **Replay** | `data::steps::replay(base_df, [(kind, params)])` |
| **Supported `kind`s** | `drop_columns`, `rename_column`, `drop_rows`, `drop_nulls`, `fill_nulls`, `change_case`, `replace_text`, `fix_invalid` |

### Report (`Report`, `ReportSpec`)
| Layer | Location |
|---|---|
| **DTO** | `shared::report::Report`, `ReportSpec`, `Aggregation`, `AggFn`, `SortSpec`, `TopNFilter`, `WindowSpec`, `ChartSpec` |
| **Table** | `reports` (migration 002 + 003 favorite + 004 folder + 005 description/is_public) |
| **RID prefix** | `RPT` |
| **DB helpers** | `db::list_reports(owner)`, `find_report`, `insert_report`, `update_report`, `delete_report`, `set_report_favorite`, `report_owner` (ownership gate) |
| **Engine** | `data::group_by::execute(df, spec)` — filter → group → sort → windows → top_n |
| **API** | `GET/POST /api/reports`, `POST /api/reports/preview` (polymorphic source), `GET/PUT/DELETE /:rid`, `POST /:rid/run`, `POST /:rid/favorite` |
| **Frontend** | `scripts/reports/index.js` (1100+ lines, charts panel + tools panel + modal); `partials/reports.html` |
| **Docs** | [`features/reports.md`](features/reports.md) · [`objects/report.md`](objects/report.md) |

### Chart (`ChartSpec`)
| Layer | Location |
|---|---|
| **DTO** | `shared::report::ChartSpec` (lives inside `ReportSpec.charts`) |
| **Kinds** | `bar`, `bar_horizontal`, `line`, `area`, `pie`, `funnel`, `gauge`, `pictorial_bar`, `scatter`, `heatmap`, `radar`, `boxplot`, `calendar` |
| **Modifiers** | `smooth` (line/area), `donut`/`half`/`rose` (pie), `regression` (scatter), `symbol`/`symbol_repeat` (pictorial_bar), `y_group_by` (heatmap/radar), `rich_labels` (pie/bar) |
| **Preview body** | `chart-render.js::chartPreviewBody` dispatches 4 shapes (subtotals / heatmap-radar / scatter-details / gauge-scalar / boxplot-5-aggs) |
| **Extractors** | `subtotalsToSeries`, `subtotalsToScalar`, `subtotalsToHeatmap`, `subtotalsToRadar`, `subtotalsToBoxplot`, `subtotalsToCalendar`, `detailsToScatterSeries` |
| **Option builders** | `chartOption(cfg, labels, values)` for category kinds; `chartOptionHeatmap`, `chartOptionRadar`, `chartOptionBoxplot`, `chartOptionCalendar` for the rest |
| **Icon → preset** | `ICON_PRESETS` in `scripts/reports/index.js` |
| **Library** | ECharts 5 (CDN, lazy-loaded via `echarts.js::loadECharts`); ecStat lazy-loaded via `loadECStat` for regression fits |
| **Docs** | [`features/charts.md`](features/charts.md) (incl. "Remaining kinds" table for parked ones) · [`objects/chart.md`](objects/chart.md) |

### Dashboard (`Dashboard`, `DashboardSpec`, `Widget`)
| Layer | Location |
|---|---|
| **DTO** | `shared::dashboard::Dashboard`, `DashboardSpec`, `Widget` |
| **Table** | `dashboards` (migration 005) |
| **RID prefix** | `DSH` |
| **Templates** | `frontend/scripts/dashboards/templates.js` — `1x1`, `2x2`, `kpi-row-2x1`, `chart-side-table`, `header-3x2` |
| **Widgets** | `chart` (`{report_id, chart_index, title_override?}`) · `text` (`{markdown}`) |
| **DB helpers** | `db::list_dashboards(owner)`, `find_dashboard`, `insert_dashboard`, `update_dashboard`, `delete_dashboard`, `set_dashboard_favorite`, `dashboard_owner` (ownership gate) |
| **API** | `GET/POST /api/dashboards`, `GET/PUT/DELETE /:rid`, `POST /:rid/favorite` |
| **Frontend** | `scripts/dashboards/index.js` builder + `widgets.js` renderers; `partials/dashboards.html` |
| **Docs** | [`features/dashboards.md`](features/dashboards.md) · [`objects/dashboard.md`](objects/dashboard.md) |

---

## Screens

### `#/landing` — pre-auth marketing
| Asset | Location |
|---|---|
| **Partial** | `partials/landing.html` — mirrors `redpash-demo/index.html` (hero, float bars, modals, bottom nav) |
| **CSS** | `styles/pages/landing.css` — pulls library components from `/vendor/redpash-components/` |
| **JS** | `scripts/pages/landing.js` — modal open/close, social-login dispatch, theme cycle, i18n setLang, eyebrow typewriter |
| **Shell hook** | `scripts/main.js` — captures `beforeinstallprompt`; owns `installPWA()` |
| **Auth start** | Google OAuth via `<a href="/api/auth/google/start">` inside `#modal-login` |
| **Auth fallback** | `api.js` redirects here on any 401 response |
| **Docs** | [`frontend/redpash-components-pages/landing-page/`](frontend/redpash-components-pages/landing-page/index.md) |

### `#/home` — authenticated dashboard (5-step scroll-snap)
| Asset | Location |
|---|---|
| **Partial** | `partials/home.html` — full-bleed (`chrome: "full"`); float bars + step-dots + avatar; 5 `.hs-card` scroll-snap step cards |
| **Steps** | 1 Dashboard · 2 Projects · 3 Files · 4 Reports · 5 Dashboards |
| **CSS** | `styles/pages/home.css` — imports library home-screen / minitable / stat-strip / upload-zone / page-dots / redtable etc. |
| **JS** | `scripts/pages/home.js` — single redtable engine + 4-entry schema registry + scroll-snap nav + Step 1 mini-tables + upload |
| **Endpoints** | `GET /api/projects` · `GET /api/projects/:rid/files` · `GET /api/files` · `GET /api/reports` · `GET /api/dashboards` · `POST /api/files/upload` (with XLSX→CSV dispatch) · `DELETE /api/reports/:rid` · `DELETE /api/dashboards/:rid` · `POST /api/auth/logout` |
| **Docs** | [`frontend/redpash-components-pages/home-page/`](frontend/redpash-components-pages/home-page/index.md) |

### `#/cleaner?file=FIL_…` — redtable + tools
| Asset | Location |
|---|---|
| **Partial** | `partials/cleaner.html` |
| **Controller** | `scripts/cleaner/index.js` — uploader, redtable mount, action dispatch |
| **Filter panel** | `scripts/cleaner/filters/panel.js` (also reused by reports) |
| **Tools sidebar** | `scripts/cleaner/tools/sidebar.js` + one module per tool |
| **Endpoint** | `GET /api/files/:rid/page?…` |
| **Docs** | [`features/cleaner.md`](features/cleaner.md) |

### `#/reports?id=RPT_…` or `?new=1` — report builder
| Asset | Location |
|---|---|
| **Partial** | `partials/reports.html` |
| **Controller** | `scripts/reports/index.js` |
| **Filter** | reused from cleaner via the same `panel.js` |
| **Charts panel** | left column, 24 collapsible category sections of icon buttons |
| **Chart modal** | `<dialog class="rp-modal" id="chart-modal">` — modal-driven create/edit |
| **Endpoint** | `POST /api/reports/preview` |

### `#/dashboards?id=DSH_…` or `?new=1` — dashboard builder
| Asset | Location |
|---|---|
| **Partial** | `partials/dashboards.html` |
| **Controller** | `scripts/dashboards/index.js` |
| **Widget renderers** | `scripts/dashboards/widgets.js` |
| **Templates** | `scripts/dashboards/templates.js` |

### `#/profile` — Profile + Settings (full-bleed 2-step scroll-snap)
| Asset | Location |
|---|---|
| **Partial** | `partials/profile.html` — full-bleed (`chrome: "full"`); two `.hs-card` step cards + float bars + step-dots + contact modal |
| **Step 1 — Profile** | Personal info / Security / Usage / Plan & Billing / Connected accounts / Danger zone |
| **Step 2 — Settings** | Appearance (theme + language) / Account jump / Data & Export / About |
| **CSS** | `styles/pages/profile.css` — imports library settings-card + home-screen + page-dots etc.; high-contrast frosted-glass `.rp-card` override matching the corner float buttons |
| **JS** | `scripts/pages/profile.js` — load `/me` + counts, populate identity + form + connections, IntersectionObserver for step-dot sync, save via `PATCH /api/me` |
| **Endpoints** | `GET /api/me` · `PATCH /api/me` · `GET /api/projects` · `GET /api/reports` · `GET /api/dashboards` · `POST /api/auth/logout` |
| **Docs** | [`frontend/redpash-components-pages/profile-page/`](frontend/redpash-components-pages/profile-page/index.md) |

### `#/settings` — UI preferences (Phase 4c)
| Asset | Location |
|---|---|
| **Partial** | `partials/settings.html` |
| **Mount** | `scripts/pages/settings.js` — GET `/me`, PATCH `/me` with `{prefs: {…}}` |
| **Persisted prefs** | `prefs.accent` (color override), `prefs.density` (`comfortable` \| `compact`) |
| **Boot apply** | `main.js::loadSession` sets `--rp-accent` from `prefs.accent` so the override survives reloads |

### `#/docs` and `#/docs/<slug>` — public docs viewer
| Asset | Location |
|---|---|
| **Partial** | `partials/docs.html` |
| **Render** | `data::render::doc` (pulldown-cmark + syntect + gray_matter) |
| **Endpoint** | `GET /api/docs`, `GET /api/docs/:slug` |

---

## Systems

### Auth (Google OAuth)
- Flow: `routes::auth::start` → Google consent → `callback` → `upsert_google_user` → `ensure_default_project` → `create_session` → `Set-Cookie: rp_session` → redirect `/`.
- Env: `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`. Missing any → dev_user fallback.
- Resolver everyone consults: `routes::me::resolve_user_rid`.
- Docs: [`auth/google.md`](auth/google.md).

### Sessions + ownership
- **Identity resolver:** `resolve_user_rid(state, headers)` — re-exported from `routes::mod` as `pub(crate)`. Returns the session user (via `rp_session` cookie) or falls back to `state.dev_user` when OAuth is unconfigured.
- **Owner gate:** `routes::ensure_owner(lookup, expected_user, label, rid)` — re-exported from `routes::mod`. Each detail handler calls a `db::*_owner(rid)` lookup helper (`project_owner` / `report_owner` / `dashboard_owner` / `file_owner`) and feeds the result through `ensure_owner`. 404s with `kind="not_found"` on miss or mismatch — same message format both ways so existence isn't leaked.
- **Coverage:** every owner-scoped handler in `routes/{me,projects,files,reports,dashboards}.rs`. The cross-resource handlers (`/reports` create + update, `/reports/preview`, `/files/:rid/joins` POST, `/dashboards` create) also check ownership of every referenced RID.

### Chart pipeline (`chart-render.js`)
- All charts share `chartOption(cfg, labels, values)` for category families; heatmap/radar/boxplot/calendar use dedicated `chartOption<Kind>`.
- All charts share `chartPreviewBody(source_file_id, cfg, filter)` for the request body.
- Scatter + heatmap + radar + boxplot + calendar + gauge have their own `subtotalsTo<Kind>` (or `detailsToScatterSeries`) extractor.
- Adding a new kind: see "Adding a new chart kind" in [`features/charts.md`](features/charts.md).

### Undo / Redo
- Module: `scripts/ui/history.js` — `createHistory(initial)` → `{push, undo, redo, reset, canUndo, canRedo}`.
- Wired in `reports/index.js` and `dashboards/index.js` via `captureSnapshot()` hook inside `previewSoon()`.
- Header `[data-undo]` / `[data-redo]` buttons + Ctrl+Z / Ctrl+Y bindings.

### Cleaner step replay
- `data::steps::replay(base_df, [(kind, params)])` dispatches per `kind` string.
- New step kinds: add an arm in `replay`, plus the corresponding `data::*` helper, plus a frontend tool module under `scripts/cleaner/tools/`.

### Report engine pipeline
1. `apply_filter(df, spec.filter)` — `data::parse::apply_filter`.
2. `lf.group_by(combined).agg(agg_exprs)` — combined = `group_by + group_by_cols`.
3. Eager `df.sort(by, opts)` (not lazy — Polars 0.43 quirk).
4. `apply_windows(df, spec.windows)` — `<fn>(col).over(partition_by)` + as_percent.
5. `apply_top_n(df, spec.top_n, fallback_part)` — sort + `group_by_stable.head(n)`.

### Frontend service worker
- `frontend/service-worker.js` — shell cache + /api network-first.
- **Bump `CACHE_VERSION` on every frontend-touching commit.** Otherwise users get stale modules.

---

## API quick reference

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/me` | session user / dev_user / 401 |
| PATCH | `/api/me` | sparse profile update + shallow `prefs` merge |
| GET | `/api/auth/google/start` | redirect to Google |
| GET | `/api/auth/google/callback` | exchange code → set rp_session → redirect / |
| POST | `/api/auth/logout` | delete session + clear cookie |
| GET | `/api/projects` | session user's projects |
| GET | `/api/projects/:rid/files` | files in project |
| POST | `/api/files/upload` | multipart `file` (+ optional `tld`). Lands in user's default project. |
| GET | `/api/files/:rid` | summary + columns + steps |
| GET | `/api/files/:rid/page` | paged rows — `?page&size&sorts&filters&search&col` |
| POST | `/api/files/:rid/steps` | apply a cleaning step |
| POST | `/api/files/:rid/undo` · `/redo` | walk the step cursor |
| POST | `/api/files/:rid/encoding` | override detected encoding |
| GET | `/api/files/:rid/dedup` | duplicate counts |
| GET | `/api/files/:rid/joins` · POST | detect candidate keys / apply a join |
| POST | `/api/files/:rid/snapshot` | save current view as a new file |
| GET | `/api/files/:rid/uniques` | per-column unique counts |
| GET | `/api/reports` | session user's reports |
| POST | `/api/reports` | create |
| POST | `/api/reports/preview` | run a spec — `source_file_id` or `source_report_id` |
| GET·PUT·DELETE | `/api/reports/:rid` | CRUD |
| POST | `/api/reports/:rid/run` | run the saved spec |
| POST | `/api/reports/:rid/favorite` | `{value}` |
| GET | `/api/dashboards` | session user's dashboards |
| POST · GET · PUT · DELETE | `/api/dashboards`, `/:rid` | CRUD |
| POST | `/api/dashboards/:rid/favorite` | `{value}` |
| GET | `/api/docs`, `/api/docs/:slug` | rendered markdown |

---

## Files cheatsheet

**"I want to add an API endpoint"** → pick the matching `routes/*.rs`, add a handler, wire into the module's `routes()` fn.
**"I want to add a SQL query"** → `crates/api/src/db.rs`. One helper per task. Take `&PgPool`, return DTOs from `shared::*`.
**"I want to add a chart kind"** → see "Adding a new chart kind" at the bottom of [`features/charts.md`](features/charts.md). Touches: `chart-render.js`, `reports/index.js`, `partials/reports.html`, `shared::report::ChartSpec` (only if new field), maybe `data::group_by::AggFn`.
**"I want to add a cleaning tool"** → backend: a new arm in `data::steps::replay` plus a helper in `data::*`. Frontend: `scripts/cleaner/tools/<tool>.js` + sidebar wiring.
**"I want to add a dashboard widget kind"** → extend `widgets.js` dispatch; new entry in `index.js` `KINDS` array; widget spec lives in `DashboardSpec.widgets[].spec`.
**"I want to add a wire-format field"** → `crates/shared/src/<obj>.rs`. Use `#[serde(default)]` so older specs deserialise.
**"I want to add a migration"** → `backend/migrations/NNNNNN_*.sql`. The api crate runs `sqlx::migrate!` at boot.

---

## Conventions & gotchas

### Polars 0.43 quirks
- **Use eager `DataFrame::sort` after `group_by().agg()`** — lazy `sort_by_exprs` chained off `group_by` has been observed to silently drop in some 0.43 builds. See `data::group_by::execute` step 5.
- **Quantile type is `QuantileInterpolOptions` (not `QuantileMethod`)** in 0.43.1 — `data::group_by::build_agg_exprs` uses `base.quantile(lit(0.25), QuantileInterpolOptions::Linear)` for `Q1`/`Q3`/`Median`.
- **`concat_str` is feature-flagged** — already enabled in the workspace Cargo.toml.
- **`with_row_index(IDX_COL, None)`** accepts `&'static str` directly — no `.into()`.

### Frontend
- **Bump `CACHE_VERSION` in `frontend/service-worker.js`** on every frontend-touching commit. The browser will keep serving stale JS otherwise.
- **Inline style attributes need single quotes** when the value contains `"…"` literals (e.g. `grid-template-areas: "a b" "c d"`). Using `style="…"` terminates at the first inner quote and breaks layout.
- **Modal pattern**: two coexist, both native `<dialog>` + `showModal()` / `close()` (ESC dispatches `cancel` — handle it to reset state).
  - `scripts/ui/modal.js` `openModal({title, body, actions})` — the **preferred** helper. Renders the redpash-components **glass modal** (`<dialog class="rp-modal--glass">` shell + `.modal` panel, `auth-modals.css`) — same look as the landing login/contact modals.
  - `<dialog class="rp-modal">` — the App's older modal (`styles/components/modal.css`, `--rp-*` tokens). Still used by the Cleaner tool modals + the Reports chart modal; not for new modals.
- **History capture hook**: `captureSnapshot()` is called from `previewSoon()`, so every spec-mutating handler that already calls `previewSoon` is automatically covered. Don't push to history from individual handlers.

### Backend
- **Owner scoping**: never read `state.dev_user.as_str()` directly — call `super::resolve_user_rid(&state, &headers)` so OAuth users get *their* data. `state.dev_user` is the dev-mode fallback only.
- **Ownership on every detail handler**: pair `resolve_user_rid` with `super::ensure_owner(db::<resource>_owner(&state.db, &rid).await, &user, "<label>", &rid)?`. Always 404 on mismatch, never 403 — keeps existence private.
- **`#[serde(default)]` on every new wire field** — older saved specs in JSONB must deserialise unchanged.
- **`#[serde(rename = "fn")]`** for any `fn_: …` field — `fn` is reserved in Rust but cleanest on the JSON side.

### Design tokens (library vs app)
- The **library** (`/home/mansa/redpash-components/`) uses **bare token names** (`--bg`, `--accent`, `--surface`).
- The **app** uses **prefixed token names** (`--rp-bg`, `--rp-accent`, `--rp-surface`).
- **Don't rename either side.** Integration is via an **alias layer** in the app's `main.css`: `--rp-bg: var(--bg);`. See [`frontend/design.md`](frontend/design.md).

### Phase progress
- 1 — Foundation ✅
- 2 — Cleaner ✅
- 3 — Reports & Dashboards ✅ (~12 chart kinds + window functions + Top-N + chart-ref widgets)
- 4a — Google OAuth flow ✅
- 4b — Per-user data scoping ✅
- 4c — Per-resource ownership + Profile/Settings + logout button ✅. Share-link UI for `is_public` toggles still pending.
- 5 — Bake frontend into binary, brotli, systemd ⬜

---

## Sister projects

- `/home/mansa/redpash-components/` — generic CSS/JS design-system library (see [`frontend/design.md`](frontend/design.md) for integration rules).
- `/home/mansa/streamlit-proj/clarna-django/` — historical Django app. Useful as a reference for behaviours not yet ported (the `md/` tree there maps roughly 1:1 to ours).
