---
title: REDMAP — find anything fast
section: Start here
order: -1
last modified date: 2026-05-27
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
│   │   │       ├── event.rs                runtime event capture — fire-and-forget record()
│   │   │       └── routes/
│   │   │           ├── mod.rs              Router assembly + ServeDir + `ensure_owner` + request-id/capture middleware
│   │   │           ├── auth.rs             Google OAuth — /start, /callback, /logout, /dev-login
│   │   │           ├── me.rs               GET + PATCH /api/me + resolve_user_rid (shared)
│   │   │           ├── health.rs           liveness
│   │   │           ├── projects.rs         list + per-project file list + PATCH/DELETE
│   │   │           ├── files.rs            upload (CSV+Excel), list, page, steps, undo/redo, joins, snapshots, export, sentinels, cleanness, cast-preview, clear-filters
│   │   │           ├── reports.rs          CRUD + /preview + /run + favorite + PATCH (sparse meta)
│   │   │           ├── dashboards.rs       CRUD + favorite + PATCH (sparse meta)
│   │   │           ├── users.rs            dev-permissive directory CRUD
│   │   │           ├── companies.rs        companies + memberships (owner/admin/member); membership IS the access check
│   │   │           └── events.rs           runtime observability log — capture + read API
│   │   ├── data/                           Polars-backed compute. No HTTP.
│   │   │   └── src/
│   │   │       ├── parse.rs                CSV → DataFrame; preamble + delimiter sniff; apply_filter; Excel→CSV via calamine
│   │   │       ├── dtype.rs                column summaries
│   │   │       ├── steps.rs                replay applied steps; dispatch by kind (18 kinds)
│   │   │       ├── group_by.rs             report engine — group/agg/sort/top_n/windows
│   │   │       ├── stats.rs                cleanness scorer + sentinel scan + unique-value extractor + cell-diff counter
│   │   │       ├── joins.rs                overlap-coefficient detector
│   │   │       ├── dedup.rs                full-row + per-PK dedup
│   │   │       ├── render.rs               markdown → HTML (pulldown-cmark + syntect + gray_matter) for `/api/docs`
│   │   │       └── encoding.rs             chardetng wrapper + BOM-first
│   │   └── shared/                         DTOs travelling over the wire
│   │       └── src/
│   │           ├── project.rs              ProjectSummary
│   │           ├── file.rs                 FileSummary, ColumnMeta, PageQuery
│   │           ├── step.rs                 ProjectStep, StepRequest
│   │           ├── filter.rs               FilterNode (Group/Leaf), FilterOp, FilterSpec
│   │           ├── report.rs               Report, ReportSpec, Aggregation, AggFn, SortSpec, TopNFilter, WindowSpec, ChartSpec
│   │           ├── dashboard.rs            Dashboard, DashboardSpec, Widget
│   │           ├── user.rs                 UserProfile, UserMembership
│   │           ├── company.rs              Company, CompanySummary, CompanyMember
│   │           └── event.rs                Event, EventReport
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
│       ├── events.js                       frontend error capture → POST /api/events
│       ├── ui/
│       │   ├── toast.js                    success/error/info toasts
│       │   └── history.js                  generic undo/redo ring buffer (reports + dashboards)
│       ├── cleaner/                        cleaner controller + filter panel + tools sidebar
│       ├── reports/index.js                ⚠ legacy builder — superseded by scripts/pages/reports.js
│       ├── dashboards/
│       │   ├── index.js                    dashboard builder (template + slots)
│       │   ├── widgets.js                  chart-ref and text widget renderers
│       │   ├── templates.js                grid template registry
│       │   ├── echarts.js                  lazy loaders (loadECharts + loadECStat)
│       │   └── chart-render.js             shared chartOption + per-kind extractors. Used by reports AND dashboards.
│       └── pages/                          per-page modules (sandbox pages: cleaner, objects, reports, profile…)
│
└── docs/                                   served at /docs (this file lives here)
    ├── REDMAP.md (this)                    one-page navigation
    ├── INDEX.md                            section TOC
    ├── getting-started.md                  run locally, phase progress
    ├── features/                           cleaner, joins, reports, dashboards, charts
    ├── objects/                            DTO reference (user, project, file, step, report, dashboard, chart)
    ├── api/                                per-resource detail (overview + health/me/auth/projects/files/reports/dashboards)
    ├── auth/google.md                      OAuth flow + cookies + dev_user fallback
    ├── db/schema.md                        tables + migrations + RID prefixes
    ├── dev/setup.md                        prereqs, watch loop
    ├── internal/                           team-only — 8 sections (architecture, subsystems, specs, flows, processes, runbooks, standup, archive). See internal/index.md.
    └── frontend/design.md                  tokens, dark mode, naming convention vs library
```

---

## Objects

### User (`UserProfile`)
| Layer | Location |
|---|---|
| **DTO** | `shared::user::UserProfile` |
| **Table** | `users` (migration 001) — `google_sub` (006), `first_name` / `last_name` (017). `users.prefs` JSONB column dropped in mig 024 — prefs now live in their own table (see User Preferences below). |
| **RID prefix** | `USR` |
| **DB helpers** | `db::find_user_by_id`, `find_user_by_username`, `find_user_by_google_sub`, `insert_user`, `upsert_google_user`, `update_user` (sparse merge over the profile fields), `ensure_default_project` |
| **API** | `GET /api/me` (returns profile + prefs merged), `PATCH /api/me` (sparse update of profile fields; prefs go via `/api/me/prefs`) |
| **Resolver** | `routes::me::resolve_user_rid(state, headers)` — single source of truth, re-exported from `routes::mod` |
| **Ownership helper** | `routes::ensure_owner(lookup, expected_user, label, rid)` — re-exported from `routes::mod`, called by every detail handler |
| **Docs** | [`auth/google.md`](auth/google.md), [`api/me.md`](api/me.md) |

### User Preferences (`UserPreferences`)
| Layer | Location |
|---|---|
| **DTO** | `shared::user::UserPreferences` |
| **Table** | `user_preferences` (migration 023) — promoted from the `users.prefs` JSONB column to a first-class table. JSONB column dropped in mig 024. |
| **Schema** | `(user_redpash_id, key)` composite PK; one row per `(user, pref-key)` pair. Value is JSONB so client-side type-shape decisions don't leak into the schema. |
| **DB helpers** | `db::get_user_preferences(user)`, `set_user_preference(user, key, value)`, `delete_user_preference(user, key)` |
| **API** | `GET /api/me/prefs`, `PATCH /api/me/prefs` (sparse update — `{key: value, …}`; setting `value: null` deletes the row) |
| **Why standalone** | Per-key writes don't race; SWR-friendly on the client; one pref's bug can't corrupt the rest of the JSONB blob. See [`docs/internal/specs/user-preferences.md`](internal/specs/user-preferences.md). |
| **Migration** | mig 023 (table + endpoint, dual-write window) → mig 024 (drop `users.prefs`). Both already shipped. |

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
| **Table** | `project_files` (migration 001). Sole entity table since the object-model hard-refresh (mig 018 `drop_reports` + mig 019 `fold_dashboards`); previously-separate Report and Dashboard rows now live here as `file_type='dashboard'` rows (a Report is a derived view of a CSV-typed File, not its own table). |
| **`file_type`** | `csv` (uploaded data), `chart` (saved chart spec — mig 016 added `spec` JSONB + `source_file_id` self-FK; CHT_ rid), `dashboard` (saved dashboard spec — mig 019; DSH_ rid). File-typed rows go through the same ownership + CRUD + cascade machinery. |
| **RID prefix** | `FIL` (csv), `CHT` (chart), `DSH` (dashboard) — all rows in `project_files`. |
| **Storage** | `<REDPASH_DATA_DIR>/files/<rid>.bin` (raw bytes for csv-typed only; chart + dashboard specs live in `project_files.spec` JSONB). |
| **In-memory** | `AppState.files: DashMap<rid, FileEntry { summary, columns, frame: Arc<DataFrame> }>` (csv-typed only — chart/dashboard rows skip the in-memory frame cache). |
| **DB helpers** | `db::insert_file`, `find_file`, `list_files_in_project`, `file_owner` (ownership gate). Chart-specific helpers live in `db::charts::*`; dashboard PATCH lives in `routes::dashboards::patch_dashboard`. |
| **API** | `POST /api/files/upload`, `GET /:rid`, `GET /:rid/page`, `POST /:rid/{steps,undo,redo,encoding,snapshot,joins}`, `GET /:rid/{dedup,joins,uniques}`. Chart CRUD: `/api/charts/*`. Dashboard PATCH: `PATCH /api/dashboards/:rid`. |
| **Hydrate** | `routes::files::hydrate(state, rid)` — csv-typed only. Chart + dashboard rows return their spec directly. |
| **Frontend** | Workspace page (`scripts/pages/workspace.js`, `partials/workspace.html`) — the unified surface that replaced the per-type Cleaner/Reports/Dashboards pages. |
| **Stage** | Computed from row state + `file_stages` view (mig 014 + mig 022 rename + mig 026 cascade triggers) — `new` / `clean` / `design` / `published`. Never stored; stage is derived. |

### Step (`ProjectStep`)
| Layer | Location |
|---|---|
| **DTO** | `shared::step::ProjectStep`, `StepRequest` |
| **Table** | `project_steps` |
| **RID prefix** | `STP` |
| **DB helpers** | `db::list_steps`, `insert_step`, `undo_last`, `redo_next`, `clear_steps_of_kind` (surgical un-apply of every step of a given kind — powers `/clear-filters`) |
| **Replay** | `data::steps::replay(base_df, [(kind, params)])` |
| **Supported `kind`s** | **Column shape:** `drop_columns`, `filter_columns` (keep listed), `rename_column`, `snake_case_columns`, `replace_in_names`, `join_columns`, `split_column`. **Row shape:** `drop_rows` (by index), `drop_nulls`, `filter_rows` (predicate-tree). **Cell value:** `set_cell`, `fill_nulls`, `cast` (with `/cast-preview` dry-run), `change_case`, `replace_text`, `fix_invalid` (sentinel replace), `format_dates`. **Rescue:** `unwrap_csv` (re-parse a fully-wrapped CSV). See [api/files.md](api/files.md#post-apifilesridsteps--apply-a-cleaning-step) for the per-kind param shapes. |
| **Docs** | [`features/cleaner.md`](features/cleaner.md) · [`objects/step.md`](objects/step.md) |

### Report (derived view — not an entity)
| Layer | Location |
|---|---|
| **Status** | Object-model hard-refresh (mig 018, 2026-06-01): `reports` table dropped. **Report is no longer a stored entity** — it's a derived view over a csv-typed File + its attached charts. The old `reports.spec` field is now `project_files.spec` on chart-typed rows (mig 016). Anywhere the URL used to need an `RPT_…` id, the source File id (`FIL_…`) is the addressable handle. |
| **DTO** | `shared::report::ReportSpec` + descendants (`Aggregation`, `AggFn`, `SortSpec`, `TopNFilter`, `WindowSpec`) retained — they're the group-by spec shape consumed by the engine, not a stored object. |
| **RID prefix** | `RPT` retired. Reports are addressed via their source `FIL_…`. |
| **Engine** | `data::group_by::execute(df, spec)` — filter → group → sort → windows → top_n. Unchanged; spec source moved from a `reports` row to the chart-typed File's `spec`. |
| **API** | `/api/reports` retired in mig 018; runtime grouped queries hit `/api/charts/:rid` (saved charts) or compose the spec inline against `/api/files/:rid/page` (ad-hoc). |
| **Frontend** | Workspace page (`scripts/pages/workspace.js`) — the report-builder UI is now a mode on the unified Workspace surface, not a separate `/reports` page. |
| **Docs** | [`docs/internal/architecture/object-model.md`](internal/architecture/object-model.md) — locked 2026-05-22 — explains the 2-entity rewrite. |

### Chart (`ChartSpec`, chart-as-File)
| Layer | Location |
|---|---|
| **DTO** | `shared::report::ChartSpec` (spec shape) + `shared::file::FileSummary` (the storage envelope) — a chart is a `project_files` row with `file_type='chart'`. |
| **Table** | `project_files` (mig 016 added `spec` JSONB + `source_file_id` self-FK). No separate `charts` table. |
| **RID prefix** | `CHT` |
| **Storage** | `project_files.spec` JSONB carries the `ChartSpec`; `source_file_id` self-FK (`ON DELETE CASCADE`) points at the csv-typed File the chart renders against. Deleting the source CSV cascades the chart. |
| **DB helpers** | `db::charts::list_charts(owner)`, `find_chart`, `insert_chart`, `update_chart`, `delete_chart`, `chart_owner` (ownership gate). |
| **API** | `GET /api/charts` (list), `POST /api/charts` (create), `GET·PUT·DELETE /api/charts/:rid` (RUD). |
| **Kinds** | `bar`, `bar_horizontal`, `line`, `area`, `pie`, `funnel`, `gauge`, `pictorial_bar`, `scatter`, `heatmap`, `radar`, `boxplot`, `calendar`, `matrix` |
| **Modifiers** | `smooth` (line/area), `donut`/`half`/`rose` (pie), `regression` (scatter), `symbol`/`symbol_repeat` (pictorial_bar), `y_group_by` (heatmap/radar/matrix), `rich_labels` (pie/bar) |
| **Preview body** | `chart-render.js::chartPreviewBody` dispatches 4 shapes (subtotals / heatmap-radar-matrix / scatter-details / gauge-scalar / boxplot-5-aggs) |
| **Extractors** | `subtotalsToSeries`, `subtotalsToScalar`, `subtotalsToHeatmap`, `subtotalsToRadar`, `subtotalsToBoxplot`, `subtotalsToCalendar`, `subtotalsToMatrix`, `detailsToScatterSeries` |
| **Option builders** | `chartOption(cfg, labels, values)` for category kinds; `chartOptionHeatmap`, `chartOptionRadar`, `chartOptionBoxplot`, `chartOptionCalendar`, `chartOptionMatrix` for the rest |
| **Builder** | Workspace page's chart-builder mode — family `<select>` + inline-SVG variant tiles. |
| **Library** | ECharts 6 (CDN, lazy-loaded via `echarts.js::loadECharts`); ecStat lazy-loaded via `loadECStat` for regression fits |
| **Docs** | [`features/charts.md`](features/charts.md) (incl. "Remaining kinds" table for parked ones) · [`objects/chart.md`](objects/chart.md) |

### Company (`Company`, `CompanyMember`, `CompanySummary`)
| Layer | Location |
|---|---|
| **DTO** | `shared::company::Company`, `CompanyMember`, `CompanySummary` |
| **Table** | `companies` + `company_memberships` (migration 007). `projects.company_id` FK is `ON DELETE SET NULL` so company projects survive a company delete as personal projects. |
| **RID prefix** | `CMP` (companies); membership rows have a composite PK `(company_id, user_redpash_id)`, no RID |
| **Roles** | `owner` > `admin` > `member`. owner-only: grant `owner`, delete company, demote/remove last owner. owner+admin: edit metadata, add/remove members. member: read-only. |
| **DB helpers** | `db::list_companies(user)` (LEFT-JOIN — non-members see the row with `my_role: null`), `get_company`, `company_role` (gate), `company_owner_count` (last-owner guard), `create_company` (TX: company + owner membership in one shot), `update_company`, `delete_company`, `list_company_members`, `add_company_member` (upsert on composite PK), `remove_company_member` |
| **API** | `GET /api/companies`, `POST /api/companies`, `GET·PATCH·DELETE /:rid`, `GET·POST /:rid/members`, `DELETE /:rid/members/:user_id` |
| **Dev relaxation** | `PATCH` + `DELETE` membership/role gates currently OFF — any signed-in user can edit/delete any company from the Objects-page Companies tab. Target gates documented in [api/companies.md](api/companies.md). |
| **Docs** | [`api/companies.md`](api/companies.md) |

### Dashboard (`DashboardSpec`, dashboard-as-File)
| Layer | Location |
|---|---|
| **Status** | Object-model hard-refresh (mig 019, 2026-06-02): `dashboards` table dropped, rows folded into `project_files` as `file_type='dashboard'`. The DSH_ rid is preserved (dashboard-typed rows kept their original RIDs through the migration). |
| **DTO** | `shared::dashboard::DashboardSpec`, `Widget` (spec shape) + `shared::file::FileSummary` (storage envelope). |
| **Table** | `project_files` with `file_type='dashboard'`; spec lives in `project_files.spec` JSONB. |
| **RID prefix** | `DSH` |
| **Templates** | `frontend/scripts/pages/workspace.js` carries the template registry (`1x1`, `2x2`, `kpi-row-2x1`, `chart-side-table`, `header-3x2`) — moved from the retired `scripts/dashboards/templates.js`. |
| **Widgets** | `chart` (`{chart_id, title_override?}` — `chart_id` is now a `CHT_…`, no more `report_id+chart_index` pairing since reports aren't entities) · `text` (`{markdown}`). |
| **DB helpers** | Generic file machinery: `db::insert_file`, `find_file`, `list_files_in_project`, `file_owner`. Dashboard-specific PATCH endpoint at `routes::dashboards::patch_dashboard` handles sparse spec merges. |
| **API** | `GET·POST /api/dashboards`, `GET·PUT·PATCH·DELETE /api/dashboards/:rid`, `POST /:rid/favorite` (sparse meta PATCH covers title/description/folder/is_favorite/is_public). |
| **Frontend** | Workspace page (`scripts/pages/workspace.js`, `partials/workspace.html`) — dashboard builder is a mode on the unified surface, not a separate `/dashboards` page. |
| **Docs** | [`features/dashboards.md`](features/dashboards.md) · [`objects/dashboard.md`](objects/dashboard.md) — both due for a refresh. |

### Case (`Case`, `Comment`)
| Layer | Location |
|---|---|
| **DTO** | `shared::case::Case`, `Comment`, `CaseCategory` |
| **Table** | `cases` + `comments` (migration 028) — Jira-flow workstream v1; the team-coordination + customer-ticket layer on top of the audit-everything spine. Extended by `cases.error_message` (mig 029, raw error payload for auto-triaged FE crash cases) and `case_categories` + `cases.category_id` (mig 030, two-level taxonomy via self-FK on `parent_id`). |
| **RID prefix** | `CAS` (cases), `CMT` (comments), `CAT` (categories). |
| **Status flow** | `backlog` → `todo` → `in_progress` → `in_review` → `done`. Click-cycle on the kanban advances; reopens (done → todo) allowed. Status mutations emit `events.kind='case_status_change'` via `routes::cases::patch`'s per-field event loop (`format!("case_{field}_change")` covers status / priority / type / assignee / category). |
| **Type / priority** | `type ∈ {bug, feature, task, epic}` · `priority ∈ {low, medium, high, critical}`. |
| **DB helpers** | `db::list_cases`, `find_case`, `insert_case`, `update_case`, `delete_case`, `list_comments_for_case`, `insert_comment`, `update_comment`, `delete_comment`, `list_case_categories`. |
| **API** | `GET·POST /api/cases`, `GET·PATCH·DELETE /api/cases/:rid`, `GET·POST /api/cases/:rid/comments`, `PATCH·DELETE /api/cases/:rid/comments/:cmt_rid`, `GET /api/cases/categories`. |
| **Lifecycle events** | `case_create`, `case_delete`, `case_comment_post`, `case_comment_edit`, `case_comment_delete` emit via `event::info`. The patch handler additionally emits `case_status_change`, `case_priority_change`, `case_type_change`, `case_assignee_change`, `case_category_change` (one per changed field; same data carries old + new values for activity-feed rendering), plus a bundled `case_metadata_change` summarising title / description / project / company edits. |
| **Frontend** | `partials/cases.html`, `scripts/pages/cases.js` — kanban board + two-column detail panel (head bar + main column + 14rem sidebar, narrow-viewport falls back to single-column at 40rem). |
| **Coordination role** | Per `docs/internal/jira-flow-proposition/proposition.md`, cases are the planned successor to the `Internal-Slack/*.md` channel system once the activity feed lands. |
| **Docs** | [`docs/internal/subsystems/cases.md`](internal/subsystems/cases.md) · [`docs/internal/cases/agent-cookbook.md`](internal/cases/agent-cookbook.md) |

### Optimization Point (`OptimizationPoint`)
| Layer | Location |
|---|---|
| **DTO** | `shared::optimization::OptimizationPoint` |
| **Table** | `optimization_points` (migration 025) — the doc-side "Optimization map" tables in each subsystem doc become a first-class queryable surface that powers the Monitoring page's Optimization tab. |
| **RID prefix** | `OPT` |
| **Fields** | `subsystem` · `axis` (Storage / Compute / Memory / Latency / etc.) · `name` · `description` · `current_value` (computed live) · `tipped` (threshold-crossed flag) · `status` ∈ `{open, planned, done, wontfix}` · `notes`. |
| **DB helpers** | `db::list_optimization_points`, `update_optimization_point_status`. |
| **API** | `GET /api/monitoring/optimization-points`, `PATCH /api/monitoring/optimization-points/:rid` (status flip from the FE pill). |
| **Live measurements** | `ROW_COUNT_TABLES` whitelist in `routes/monitoring.rs` drives the `current_value` for table-row-count-typed points; other axes hardcode their measurement source. |
| **Docs** | [`docs/internal/specs/optimization-map.md`](internal/specs/optimization-map.md) |

### Request Log (`RequestSummary`, `RequestDetail`)
| Layer | Location |
|---|---|
| **DTO** | `shared::monitoring::RequestSummary`, `RequestDetail` |
| **Table** | `request_log` (migration 020) — append-only per-HTTP-request capture. Extended in mig 027 (`user_redpash_id` + `session_id` columns + `(user_redpash_id, at DESC)` index — slice B of audit-everything). |
| **RID prefix** | None (auto-increment `id`). The correlatable id is `request_id` (`req_<uuid>`), echoed via `X-Request-Id`. |
| **Writer** | `capture_mw` middleware (`routes::mod`) — per-request fire-and-forget INSERT post-response, populated with user via the same `find_session_user` lookup as the 4xx/5xx event path. |
| **DB helpers** | Direct sqlx in `routes::monitoring` — no `db::` wrapper since the writer is the middleware. |
| **API** | `GET /api/monitoring/requests` (paginated list with `?window`/`?route`/`?status`/`?method`/`?q` filters), `GET /api/monitoring/requests/stats` (status-mix donut + latency histogram), `GET /api/monitoring/request/:request_id` (single-request drill-down with associated events). |
| **Frontend** | Monitoring page's Requests tab — paginated redtable, status-mix donut, click-to-replay modal. Per-user activity feed (`GET /api/monitoring/users/:rid/activity`) UNIONs `request_log` + `events` on the server side into one `Page<ActivityRow>` stream. |
| **Docs** | [`docs/internal/specs/admin-monitoring-surfaces.md`](internal/specs/admin-monitoring-surfaces.md) — slice E (M-1 / M-2 / M-4) covers the per-request drill-down + per-user feed + error-chain expander. |

### Event (`Event`)
| Layer | Location |
|---|---|
| **DTO** | `shared::event::Event`, `EventReport` |
| **Table** | `events` (migration 013 — `20260529000001_events.sql`) |
| **RID prefix** | `EVT` |
| **Capture** | *auto* — `routes::mod::capture_mw` logs every 4xx/5xx; *explicit* — `event::record(&db, EventDraft)` at lifecycle sites — or the ergonomic builders `event::info / warn / error(pool, kind, msg).user(u).context(c).send()` (`780b3c9`); *frontend* — `scripts/events.js` (uncaught JS errors, promise rejections, transport failures, page load/mount failures) → `POST /api/events` |
| **Kinds emitted today** | **Auth:** `auth_login`, `auth_logout`, `unauthenticated`, `forbidden`, `oauth_disabled`, `dev_login_disabled`. **Files:** `file_upload`, `file_delete`, `file_patch`, `file_re_encode`, `file_snapshot`. **Steps:** `step_apply`. **Projects:** `project_create`, `project_patch`. **Charts:** `chart_create`, `chart_update`, `chart_delete`. **Dashboards:** `dashboard_update`, `dashboard_patch`, `dashboard_delete`. **Companies:** `company_create`, `company_update`, `company_delete`, `company_member_leave`. **Users:** `user_create`. **Cases:** `case_create`, `case_delete`, `case_comment_post`, `case_comment_edit`, `case_comment_delete`, `case_status_change`, `case_priority_change`, `case_type_change`, `case_assignee_change`, `case_category_change`, `case_metadata_change`. **System:** `http_error`, `panic`, `avatar_fetch_failed`, `db`, `io`, `internal`. **Audit findings (FE side):** `selector_conflict`, `class_divergence`, `component_candidate`. |
| **Write** | `event::record` — fire-and-forget (spawns the INSERT on a detached task; a logging failure never blocks or fails the request) |
| **DB helpers** | `db::list_events(level, kind, limit)`, `db::find_event`, `db::list_events_for_request`. |
| **API** | `GET /api/events` (filter `level`/`kind`/`limit`), `GET /api/events/:rid`, `POST /api/events` (frontend report) |
| **Correlation** | `request_id` (per request, echoed as `X-Request-Id`) + `session_id` (`rp_session` RID) |
| **Docs** | [`api/events.md`](api/events.md) |

---

## Screens

### `#/landing` — pre-auth marketing
| Asset | Location |
|---|---|
| **Partial** | `partials/landing.html` — mirrors `redpash-demo/index.html` (hero, float bars, modals, bottom nav) |
| **CSS** | `styles/pages/landing.css` — imports components from `styles/base/` + `styles/components/` |
| **JS** | `scripts/pages/landing.js` — modal open/close, social-login dispatch, theme cycle, i18n setLang, eyebrow typewriter |
| **Shell hook** | `scripts/main.js` — captures `beforeinstallprompt`; owns `installPWA()` |
| **Auth start** | Google OAuth via `<a href="/api/auth/google/start">` inside `#modal-login` |
| **Auth fallback** | `api.js` redirects here on any 401 response |
| **Docs** | [`frontend/redpash-components-pages/landing-page/`](frontend/redpash-components-pages/landing-page/index.md) |

### `#/home` — authenticated home (pipeline board)
| Asset | Location |
|---|---|
| **Partial** | `partials/home.html` — full-bleed (`chrome: "full"`); float bars + avatar; a top strip (greeting + Projects/Files/Published counts + upload zone) above the `#home-pipe` board |
| **Board** | four stage columns — import → clean → report → publish. Every project is a card in its computed-stage column; a card click jumps to the tool for the project's next step |
| **CSS** | `styles/pages/home.css` — `rp-pipe` board styles; `#page-home` accent pinned to the app blue (`#60a5fa` / `#2563eb`) |
| **JS** | `scripts/pages/home.js` — `renderBoard()` buckets `/api/projects` by stage into the four columns |
| **Endpoints** | `GET /api/projects` (the board) · `GET /api/reports` · `GET /api/dashboards` (the Published count) · `POST /api/files/upload` (XLSX→CSV dispatch) · `POST /api/auth/logout` |
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

### `#/reports?project=PRJ_…&file=FIL_…` — reports + chart builder
| Asset | Location |
|---|---|
| **Partials** | `partials/reports/` — `index.html` composition root + `proj-tabs` / `header` / `file-tabs` / `toolbar` / `table` / `chart-dock` |
| **Module** | `scripts/pages/reports.js` — sandbox port |
| **Layout** | 2-page vertical scroll-snap deck — Page 1 Data (chrome + read-only source redtable), Page 2 Charts (builder rail + chart dock) |
| **Chart builder** | left rail: family `<select>` + inline-SVG variant tiles; no modal |
| **Persistence** | saved charts → `localStorage['rp_saved_charts_v1']` (per-project stopgap; backend `FIL_` File pending) |
| **Endpoint** | `POST /api/reports/preview` (one per chart) |

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

### `#/cases` and `#/cases?id=CAS_…` — issue tracker (kanban + detail overlay)
| Asset | Location |
|---|---|
| **Partial** | `partials/cases.html` — rail-page shell; main column hosts a kanban board grouped by status (`backlog`/`todo`/`in_progress`/`in_review`/`done`); a detail panel (`.rp-cases-detail`) slides over from the right when `?id=CAS_…` is present |
| **Detail panel** | head bar (rid · hero title · ✕) over a two-column body: left = comments thread + sticky compose form; right = 14rem sidebar with editable controls (status / priority / type / assignee), meta dl, collapsible `<details>` Description + Activity. `@media (max-width: 40rem)` falls back to single-column. Restructure shipped 2026-05-25 (`4fbafe4`). |
| **CSS** | `styles/cases.css` — kanban + rail + detail panel atoms (`.rp-cases-detail-main`, `.rp-cases-detail-side`, `.rp-cases-detail-side-meta`, `.rp-cases-detail-side-section`, `.rp-cases-detail-side-desc-body`) + sidebar-scoped activity-item compaction |
| **JS** | `scripts/pages/cases.js` — board paint, `loadCaseDetail` / `paintDetail`, assignee picker, comment compose + submit, activity render + filter pills (`ACTIVITY_PILLS` single-source) |
| **Endpoints** | `GET /api/cases` · `GET /api/cases/:rid` (case + comments + activity) · `POST /api/cases` · `PATCH /api/cases/:rid` (sparse status/priority/type/assignee) · `POST /api/cases/:rid/comments` · `GET /api/admin/users?q=…` (assignee picker) |
| **Docs** | [`internal/subsystems/cases.md`](internal/subsystems/cases.md) (detail-panel structure) · [`internal/cases/agent-cookbook.md`](internal/cases/agent-cookbook.md) (HTTP API recipes) |

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

### Event capture (observability)
- Two `/api/*` middlewares: `request_id_mw` mints a per-request id (echoed as the `X-Request-Id` header); `capture_mw` persists every 4xx/5xx response as an `events` row.
- `AppError::into_response` stashes an `EventInfo` extension (kind + message) so `capture_mw` recovers the real error after the handler returns. Responses with no extension (Axum's own 404/405, 413, extractor 400s) are logged by status alone.
- Explicit `event::record(&db, EventDraft { … })` at lifecycle sites for `info` events. **Fire-and-forget** — the insert is spawned on a detached task, never awaited; a logging failure can't break the request.
- **Frontend capture** (`scripts/events.js`) — global `error` / `unhandledrejection` handlers, an `api.js` transport-failure funnel, and router page script/mount failures, all POSTed to `/api/events` (`origin=frontend`; `user`/`session` stamped server-side from the cookie, never trusted from the body). Captures what the backend can't see — HTTP 4xx/5xx responses are *not* re-reported client-side, `capture_mw` already owns them. Repeats deduped within 10s, session capped at 100, and `reportEvent` uses raw `fetch` so a failed event POST can't recurse.

### Audit ingest (dev-meta, NOT app data)
- `tools/audit.sh` runs every `tools/*-audit/audit.js` and ingests the JSON outputs into `audit.run` + `audit.finding` via `backend/crates/api/src/bin/audit_ingest.rs`.
- Accepted tool names (per [mig 031][m031]): `css`, `html`, `parallel`, `tab-compare`, `cross-page`, `ui-snapshot`. Names are canonical — the audit.sh script strips the `css-` directory prefix so `tools/css-tab-compare-audit/` ingests as `tab-compare`.
- Each tool's findings are exploded into `audit.finding` rows via `explode()`'s per-tool match. The finding shape (key, severity, detail) per tool is the canonical contract that drives `audit.run_diff(latest, prev)` — same key + different severity → `regressed` / `improved`; new key → `new`; missing key → `fixed`.
- **Source of truth for the per-tool contract:** [`internal/specs/audit-ingest-explode.md`](internal/specs/audit-ingest-explode.md).

[m031]: ../backend/migrations/20260613000001_relax_audit_tool_check.sql

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
| PATCH | `/api/projects/:rid` | sparse: `name` / `description` / `is_default` / `owner_id` / `company_id` / `status` |
| DELETE | `/api/projects/:rid` | cascades files+steps+reports+dashboards; default project is 400 `is_default` |
| GET | `/api/files` | every file the session user owns (across all their projects) — powers Home "My Files" |
| POST | `/api/files/upload` | multipart `file` (+ optional `tld`, `project_name`). Auto-routes into a named or default project; XLSX/XLS/XLSM/XLSB/ODS auto-converted to CSV. |
| GET | `/api/files/:rid` | summary + columns + steps |
| PATCH | `/api/files/:rid` | sparse: `display_name` / `project_redpash_id` (move) / `encoding` / `delimiter` |
| DELETE | `/api/files/:rid` | cascade history + reports; evict cache; unlink blob |
| GET | `/api/files/:rid/page` | paged rows — `?page&size&sorts&filters&q&cols` |
| POST | `/api/files/:rid/steps` | apply a cleaning step (validates against the cached frame before persisting) |
| POST | `/api/files/:rid/cast-preview` | dry-run a `cast` step — returns would-null count + sample source values |
| POST | `/api/files/:rid/undo` · `/redo` | walk the step cursor |
| POST | `/api/files/:rid/clear-filters` | surgically un-apply every `filter_rows` step (eraser button) |
| POST | `/api/files/:rid/encoding` | override detected encoding |
| GET | `/api/files/:rid/dedup` | duplicate counts |
| GET | `/api/files/:rid/uniques` | per-column unique values — filter-panel autocomplete |
| GET | `/api/files/:rid/sentinels` | scan for sentinel values (`n/a`, `?`, …) + caller's `?extra=` set — `fix_invalid` modal data |
| GET | `/api/files/:rid/joins` · POST | detect candidate keys (filter-aware) / apply a join (filter-aware, streamed to disk) |
| POST | `/api/files/:rid/snapshot` | save current view as a new file (no step history) |
| GET | `/api/files/:rid/export` | stream current view as downloadable CSV (no DB write) |
| POST | `/api/files/:rid/cleanness` · DELETE | recompute (against globals ∪ user `learned_sentinels`) / null-out the score |
| GET | `/api/reports` | session user's reports |
| POST | `/api/reports` | create — gated on source file ownership |
| POST | `/api/reports/preview` | run a spec — polymorphic `source_file_id` or `source_report_id` |
| GET·PUT·PATCH·DELETE | `/api/reports/:rid` | CRUD + sparse meta PATCH (`title` / `description` / `folder` / `is_favorite` / `is_public`) |
| POST | `/api/reports/:rid/run` | run the saved spec |
| POST | `/api/reports/:rid/favorite` | `{value}` |
| GET | `/api/dashboards` | session user's dashboards |
| POST · GET · PUT · PATCH · DELETE | `/api/dashboards`, `/:rid` | CRUD + sparse meta PATCH (same shape as reports) |
| POST | `/api/dashboards/:rid/favorite` | `{value}` |
| GET | `/api/users` | every user (with each user's `company_memberships`) — Objects Users tab + owner-reassignment picker |
| POST · GET · PATCH · DELETE | `/api/users`, `/:rid` | dev-permissive CRUD; `username` UNIQUE → 409 `username_taken` |
| GET | `/api/companies` | every company w/ caller's `my_role` (null when not a member) + `member_count` |
| POST | `/api/companies` | create — creator seated as `owner` in one TX; slug suffixed with RID slice (no collision retry) |
| GET·PATCH·DELETE | `/api/companies/:rid` | read needs membership; PATCH/DELETE currently dev-permissive (target: owner-only delete, owner/admin PATCH) |
| GET·POST | `/api/companies/:rid/members` | list / upsert (owner-only for `role: owner`); last-owner demotion blocked |
| DELETE | `/api/companies/:rid/members/:user_id` | leave (self) or remove (owner/admin); last-owner removal blocked |
| GET | `/api/events` | recent events, newest first — filter `?level=` `?kind=` `?limit=` |
| GET | `/api/events/:rid` | one event |
| POST | `/api/events` | frontend-reported event — `origin=frontend`, `user`/`session` stamped server-side |
| POST | `/api/auth/dev-login` | mint a session for any user RID — gated by `REDPASH_DEV_LOGIN=1`, otherwise 403 |
| GET | `/api/docs`, `/api/docs/:slug` | rendered markdown |
| GET | `/api/cases` | session user's cases (paginated `Page<CaseSummary>`) |
| POST | `/api/cases` | create — body `{ title, description?, type?, priority?, project_id? }` |
| GET | `/api/cases/:rid` | full case + comments thread + activity feed in one payload |
| PATCH | `/api/cases/:rid` | sparse: `status` / `priority` / `type` / `assignee_id` / `title` / `description`. Status changes emit `case_status_change` events; assignee changes emit `case_assignee_change`. |
| DELETE | `/api/cases/:rid` | cascades `comments` (ON DELETE CASCADE per mig 014) |
| GET·POST | `/api/cases/:rid/comments` | list / append. Body shape is Markdown (`comments.body` annotated as such in mig 014); render layer pending — see [`internal/subsystems/cases.md`](internal/subsystems/cases.md) open lanes |
| GET | `/api/charts` | session user's chart-typed files (`project_files.file_type = 'chart'`) |
| POST | `/api/charts` | create a chart-typed File row; body `{ project_id, source_file_id, spec: { option, svg } }` |
| GET·PUT·DELETE | `/api/charts/:rid` | read / update spec / delete. `file_stages` derives `report` stage when ≥1 chart exists in the project |

---

## Files cheatsheet

**"I want to add an API endpoint"** → pick the matching `routes/*.rs`, add a handler, wire into the module's `routes()` fn.
**"I want to add a SQL query"** → `crates/api/src/db.rs`. One helper per task. Take `&PgPool`, return DTOs from `shared::*`.
**"I want to add a chart kind"** → see "Adding a new chart kind" at the bottom of [`features/charts.md`](features/charts.md). Touches: `chart-render.js`, `scripts/pages/reports.js` (`_CHART_FAMILIES`), `partials/reports/chart-dock.html`, `shared::report::ChartSpec` (only if new field), maybe `data::group_by::AggFn`.
**"I want to add a cleaning tool"** → backend: a new arm in `data::steps::replay` plus a helper in `data::*`. Frontend: `scripts/cleaner/tools/<tool>.js` + sidebar wiring.
**"I want to add a dashboard widget kind"** → extend `widgets.js` dispatch; new entry in `index.js` `KINDS` array; widget spec lives in `DashboardSpec.widgets[].spec`.
**"I want to add a wire-format field"** → `crates/shared/src/<obj>.rs`. Use `#[serde(default)]` so older specs deserialise.
**"I want to add a migration"** → `backend/migrations/NNNNNN_*.sql`. The api crate runs `sqlx::migrate!` at boot.

---

## Conventions & gotchas

### Commit messages

- **Subject:** `area: imperative summary` — lowercase area prefix (`docs:`, `css:`, `feat:`, `tools:`, `fix:`, …), under ~70 chars.
- **Body — a per-file changelog.** One bullet per touched file: `path — what changed (and why, if not obvious)`. A reviewer gets "which part to check" straight from `git log` / `git show --stat`, no diffing required.
- **Sign-off — the last body line.** End the body with `— <Name>` (your contributor name: `— Gus`, `— Woz`, `— Torv`). Keeps authorship visible in plain `git log` now that everyone shares the `prerelease` branch.
- **Touched a doc?** Bump its `last modified date` frontmatter in the *same* commit — it's the per-file freshness proxy the docs are ranked by.
- **One commit = one coherent change** — avoid broad `checkpoint:` commits bundling unrelated efforts; they can't be reviewed or reverted per-feature.

Example body:

```
docs: sync REDMAP for the Events system

- REDMAP.md — new Event entry in Objects; /api/events in the API table.
- db/schema.md — events table + indexes; EVT prefix marked live.
- api/events.md — new per-resource doc.

— Gus
```

### Polars 0.43 quirks
- **Use eager `DataFrame::sort` after `group_by().agg()`** — lazy `sort_by_exprs` chained off `group_by` has been observed to silently drop in some 0.43 builds. See `data::group_by::execute` step 5.
- **Quantile type is `QuantileInterpolOptions` (not `QuantileMethod`)** in 0.43.1 — `data::group_by::build_agg_exprs` uses `base.quantile(lit(0.25), QuantileInterpolOptions::Linear)` for `Q1`/`Q3`/`Median`.
- **`concat_str` is feature-flagged** — already enabled in the workspace Cargo.toml.
- **`with_row_index(IDX_COL, None)`** accepts `&'static str` directly — no `.into()`.

### Frontend
- **Bump `CACHE_VERSION` in `frontend/service-worker.js`** on every frontend-touching commit. The browser will keep serving stale JS otherwise.
- **Inline style attributes need single quotes** when the value contains `"…"` literals (e.g. `grid-template-areas: "a b" "c d"`). Using `style="…"` terminates at the first inner quote and breaks layout.
- **Modal pattern**: two coexist, both native `<dialog>` + `showModal()` / `close()` (ESC dispatches `cancel` — handle it to reset state).
  - `scripts/ui/modal.js` `openModal({title, body, actions})` — the **preferred** helper. Renders the **glass modal** (`<dialog class="rp-modal--glass">` shell + `.modal` panel, `styles/components/auth-modals.css`) — same look as the landing login/contact modals.
  - `<dialog class="rp-modal">` — the App's older modal (`styles/components/modal.css`, `--rp-*` tokens). Still used by the Cleaner tool modals + the Reports chart modal; not for new modals.
- **History capture hook**: `captureSnapshot()` is called from `previewSoon()`, so every spec-mutating handler that already calls `previewSoon` is automatically covered. Don't push to history from individual handlers.

### Backend
- **Owner scoping**: never read `state.dev_user.as_str()` directly — call `super::resolve_user_rid(&state, &headers)` so OAuth users get *their* data. `state.dev_user` is the dev-mode fallback only.
- **Ownership on every detail handler**: pair `resolve_user_rid` with `super::ensure_owner(db::<resource>_owner(&state.db, &rid).await, &user, "<label>", &rid)?`. Always 404 on mismatch, never 403 — keeps existence private.
- **`#[serde(default)]` on every new wire field** — older saved specs in JSONB must deserialise unchanged.
- **`#[serde(rename = "fn")]`** for any `fn_: …` field — `fn` is reserved in Rust but cleanest on the JSON side.

### Design tokens (library vs app)
- The internalized component sheets (tokens in `styles/base/tokens.css`) use **bare token names** (`--bg`, `--accent`, `--surface`).
- The **app** uses **prefixed token names** (`--rp-bg`, `--rp-accent`, `--rp-surface`).
- **Don't rename either side.** Integration is via an **alias layer** in the app's `main.css`: `--rp-bg: var(--bg);`. See [`frontend/design.md`](frontend/design.md).

### Phase progress
- 1 — Foundation ✅
- 2 — Cleaner ✅ — 18 step kinds shipped: 7 column-shape ops (`drop_columns`, `filter_columns`, `rename_column`, `snake_case_columns`, `replace_in_names`, `join_columns`, `split_column`), 3 row-shape (`drop_rows`, `drop_nulls`, `filter_rows`), 6 cell-value (`set_cell`, `fill_nulls`, `cast`, `change_case`, `replace_text`, `fix_invalid`, `format_dates`), 1 rescue (`unwrap_csv`). Excel→CSV at upload (calamine). Live cleanness scoring.
- 3 — Reports & Dashboards ✅ (~13 chart kinds + window functions + Top-N + chart-ref widgets)
- 4a — Google OAuth flow ✅
- 4b — Per-user data scoping ✅
- 4c — Per-resource ownership + Profile/Settings + logout button ✅. Share-link UI for `is_public` toggles still pending.
- 4d — Multi-tenancy data model ✅ — companies + memberships (`owner` > `admin` > `member`), `projects.company_id` (set/re-scope; clear-to-personal pending), dev-permissive `/api/users` + `/api/companies` CRUD, `REDPASH_DEV_LOGIN` "log in as user" switch, shared-sentinel learning loop (`prefs.learned_sentinels` + `prefs.share_sentinels` consent gate + `global_sentinels` view). **Pending:** company-scoped resource visibility — every owner-scoped endpoint still gates on `projects.owner_id` alone; `project_memberships` exists in schema but isn't read.
- 5 — Bake frontend into binary, brotli, systemd ⬜

---

## Migrations

Source-of-truth ordering at `backend/migrations/<YYYYMMDDNNNNNN>_<slug>.sql`. The `api` crate runs `sqlx::migrate!` at boot. Per-table schema breakdown lives in [`db/schema.md`](db/schema.md#migrations); this table is the one-line navigation cheatsheet.

Files are listed in chronological (boot-replay) order. The **Ord** column tracks the in-file `── NNN ──` header ordinal where one exists; that convention started mid-stream at `chart_files` (Ord 016) and isn't applied consistently to every later file (`audit_run_diff` has no ordinal; the stream jumps 025 → 027 — there is no 026). When referring to a migration in commit messages or threads, prefer the **file name** — it's unambiguous.

| Ord | File | Adds |
|-----|------|------|
| —   | `20260512000001_init.sql`                  | `users`, `projects`, `project_files`, `project_steps` |
| —   | `20260513000001_reports.sql`               | `reports` table (dropped in `drop_reports`) |
| —   | `20260514000001_report_favorite.sql`       | `reports.is_favorite` + partial index (gone with `drop_reports`) |
| —   | `20260515000001_report_folder.sql`         | `reports.folder` + index (gone with `drop_reports`) |
| —   | `20260516000001_dashboards.sql`            | `dashboards` table + `reports.description` + both `is_public` (table gone in `fold_dashboards`; flags absorbed by `project_files`) |
| —   | `20260520000001_auth.sql`                  | `users.google_sub` + partial unique index + `sessions` table |
| —   | `20260521000001_companies.sql`             | `companies`, `company_memberships`, `project_memberships` + `projects.company_id` |
| —   | `20260522000001_project_stage_status.sql`  | `projects.stage` + `projects.status` (CHECK-constrained) + indexes |
| —   | `20260523000001_computed_stages.sql`       | Drops `projects.stage` + `project_files.status`; adds `file_stages` view (stage is computed) |
| —   | `20260524000001_sentinel_submissions.sql`  | `sentinel_submissions` shared-vocab table + `global_sentinels` view |
| —   | `20260525000001_filename_stem.sql`         | Strips upload extension off `project_files.filename` / `display_name`; `file_type` owns the extension half |
| —   | `20260526000001_mtime_cascade.sql`         | Trigger chain — child INSERT/UPDATE/DELETE bumps parent's `updated_at` (steps → files → projects; reports/dashboards → projects) |
| —   | `20260527000001_dependency_mtime_cascade.sql` | Companion triggers — `project_files` UPDATE bumps reports that source it; `reports` UPDATE bumps dashboards referencing it |
| —   | `20260528000001_audit_storage.sql`         | `audit.run` + `audit.finding` in separate `audit` schema — dev-meta, persists audit-tool output for trend tracking |
| —   | `20260529000001_events.sql`                | `events` table — runtime observability log |
| 016 | `20260530000001_chart_files.sql`           | `project_files.spec` (JSONB) + `project_files.source_file_id` self-FK — saved charts become first-class `project_files` rows with `file_type='chart'` |
| 017 | `20260531000001_user_names.sql`            | `users.first_name` + `users.last_name` (backfilled from `display_name`) |
| 018 | `20260601000001_drop_reports.sql`          | **Drops the `reports` table.** Object-model hard-refresh Phase 1 — reports become derived views over a csv-typed File. Locked 2-entity model. |
| 019 | `20260602000001_fold_dashboards.sql`       | **Drops the `dashboards` table.** Phase 2 — dashboards become `project_files` rows with `file_type='dashboard'`. DSH_ rids preserved through migration. |
| 020 | `20260603000001_request_log.sql`           | `request_log` table — append-only per-HTTP-request capture (route, status, latency). Powers `/api/metrics` + the Monitoring Requests tab |
| —   | `20260604000001_audit_run_diff.sql`        | `audit.run_diff` parameterized projection — classifies findings new/closed/unchanged across two runs |
| 022 | `20260605000001_stage_rename.sql`          | Stage label rename: `import → new`, `report → design`. Matches the locked stage vocabulary |
| 023 | `20260606000001_user_preferences.sql`      | `user_preferences` table — promotes prefs from a JSONB column to a first-class object (Phase 1 of user-prefs migration) |
| 024 | `20260607000001_drop_users_prefs.sql`      | Drops the now-dead `users.prefs` JSONB column (Phase 2 of user-prefs migration — completes the cut-over) |
| 025 | `20260608000001_optimization_points.sql`   | `optimization_points` table — the doc-side "optimization map" becomes a queryable surface that powers the Monitoring Optimization tab |
| 027 | `20260609000001_request_log_user_session.sql` | `request_log.user_redpash_id` + `session_id` + `(user_redpash_id, at DESC)` partial index. Powers per-user investigation queries (audit-everything slice B) |
| 028 | `20260610000001_cases.sql`                 | `cases` + `comments` tables — Jira-flow workstream v1. CAS_ + CMT_ rids. Lifecycle changes mirror into `events` (`case_*` kinds) |
| 029 | `20260611000001_cases_error_message.sql`   | `cases.error_message` — raw error payload field for cases auto-triaged from FE crash / panic events |
| 030 | `20260612000001_case_categories.sql`       | `case_categories` table + `cases.category_id` FK. Two-level taxonomy via self-FK on `parent_id` |
| 031 | `20260613000001_relax_audit_tool_check.sql` | Relaxes `audit.run.tool` CHECK to the broader audit family — adds `parallel`, `tab-compare`, `cross-page`, `ui-snapshot` alongside the original `css` + `html`. Gates Layer 1a audit-ingest broadening; see [`internal/specs/audit-ingest-explode.md`](internal/specs/audit-ingest-explode.md) for the per-tool finding contract |

---

## Sister projects

- `/home/mansa/redpash-components/` — the original CSS/JS design-system library. **No longer a dependency** — all CSS was internalized into `frontend/styles/` (2026-05-20; see [`all-css-in-redpash-project.md`](../all-css-in-redpash-project.md)). The directory remains only for the standalone design sandbox.
- `/home/mansa/streamlit-proj/clarna-django/` — historical Django app. Useful as a reference for behaviours not yet ported (the `md/` tree there maps roughly 1:1 to ours).
