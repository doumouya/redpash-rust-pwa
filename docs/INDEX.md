---
title: Documentation index
section: Start here
order: 0
last modified date: 2026-05-27
---

# RedPash docs

These docs are served at `/docs` (public — no auth required). The Rust
backend renders each markdown file via `data::render::doc`
(pulldown-cmark + syntect for code highlighting + gray_matter for the
YAML frontmatter above).

## Sections

### Start here
- [REDMAP](REDMAP.md) — **read first.** One-page navigation: surface map, objects, screens, systems, API table, files cheatsheet, conventions & gotchas.
- [INDEX](INDEX.md) — this page.
- [Getting started](getting-started.md) — run it locally, phase progress.
- [Vision](VISION.md) — product intent, personas, roadmap, pricing.

### Features (the user-facing surface)
- [Cleaner workspace](features/cleaner.md) — paginated redtable, cleaning tools, undo/redo.
- [Joins](features/joins.md) — detect candidate keys via overlap score; apply two-file joins.
- [Reports](features/reports.md) — group-by, matrix, filter, sort, Top-N, window functions, charts panel.
- [Dashboards](features/dashboards.md) — chart-ref widgets on a 12-column grid.
- [Charts](features/charts.md) — the chart types and how they render via `charts/build.js`.

### Objects (DTOs that travel over the wire)
- [Object model](objects/object-model.md) — **the locked contract.** Two entities (Project, File); Report/Dashboard are derived views; stage is computed.
- [User](objects/user.md) — `UserProfile`, `users` table, bootstrap + OAuth upsert, `resolve_user_rid`.
- [Project](objects/project.md) — `ProjectSummary`, default-project lifecycle, `ensure_default_project`.
- [File](objects/file.md) — `FileSummary` + `ColumnMeta` + `PageQuery` + `Row`, upload → step → hydrate, step kinds.
- [Step](objects/step.md) — `ProjectStep` + `StepRequest`, the append-only cleaning-op log, apply/undo/redo, 18 step kinds.
- [Report](objects/report.md) — `Report` + `ReportSpec` + `Aggregation` + `SortSpec` + `TopNFilter` + `WindowSpec`.
- [Dashboard](objects/dashboard.md) — `Dashboard` + `DashboardSpec` + `Widget`.
- [Chart](objects/chart.md) — `ChartSpec` field reference and per-kind requirements.

### API
- [API overview](api/overview.md) — map, cross-cutting (error shape, auth, cookies, pagination, layers).
- [Health](api/health.md) — `/api/health` liveness.
- [Me](api/me.md) — `/api/me` (+ avatar, prefs) + the `resolve_user_rid` spec used everywhere.
- [Auth](api/auth.md) — `/api/auth/google/*` + `/logout` (cookies, errors).
- [Users](api/users.md) — `/api/users/*` directory CRUD (dev-permissive).
- [Projects](api/projects.md) — `/api/projects` list/CRUD + `/:rid` + `/:rid/files`.
- [Companies](api/companies.md) — `/api/companies/*` CRUD; the multi-tenancy boundary + role model.
- [Connectors](api/connectors.md) — `/api/connectors/*` persisted Kafka/connector configs; the user-chosen destination project.
- [Teams](api/teams.md) — `/api/teams/*` company-scoped subgroups (grant-bearing principals).
- [Members](api/members.md) — the generic `/:rid/members` CRUD mounted under companies/projects/cases/teams.
- [Files](api/files.md) — `/api/files/*` upload, page, steps (+ preview), undo/redo, joins, snapshots.
- [Charts](api/charts.md) — `/api/charts/*` saved-chart CRUD (chart-typed `project_files`).
- [Dashboards](api/dashboards.md) — `/api/dashboards/*` CRUD; widgets point at saved charts.
- [Cases](api/cases.md) — `/api/cases/*` issue tracker + comments + categories.
- [Events](api/events.md) — `/api/events` runtime observability log — capture middleware + read API.
- [Search](api/search.md) — `/api/search` omnisearch backing the topbar.
- [Metrics](api/metrics.md) — `/api/metrics` request-log performance read (platform-admin).
- [Monitoring](api/monitoring.md) — `/api/monitoring/*` events / requests / queries / audit (platform-admin).
- [Admin](api/admin.md) — `/api/admin/*` org-wide admin read/write surface (platform-admin).

> `api/reports.md` is a retired stub (the `/api/reports/*` resource was removed in
> mig 016 — reports are now a derived view over a CSV file + its charts).

### Database
- [Schema](db/schema.md) — tables, indexes, RedPash-ID prefix table.
- [RedPash-ID](db/redpash-id.md) — `{PFX}_{32-char uppercase}` format, prefix table, generation code.

### Dev
- [Local setup](dev/setup.md) — prereqs, watch loop, frontend reload.
- [Tech stack](dev/stack.md) — every component + its pinned version: Rust/crates, Postgres, Node, the frontend ES level.

### Frontend
- [Design tokens](frontend/design.md) — CSS variables, brand, dark mode, library integration + leak-class discipline.
- [CSS units](frontend/css-units.md) — relative-by-default rule: prefer rem / em / % over px; px only for hairlines + hardware-pixel snap.
- [Unified surface](frontend/unified-surface.md) — future milestone: RedPash as one Excel-like window; parent-tab isolation, child-tab shared data.
- [Landing page](frontend/redpash-components-pages/landing-page/index.md) — first surface composing `redpash-components`. Hero / float bars / modals / i18n / theme toggle / PWA install / typewriter / shimmer.
- [Home page](frontend/redpash-components-pages/home-page/index.md) — authenticated landing: the org command center; rail-page shell, per-tab LIST_VIEWS (Users / Companies / Memberships / Cases / Projects / Files / Charts), sortable & reorderable columns.
- [Objects page](frontend/redpash-components-pages/objects-page/index.md) — the browse surface: one redtable, customizable tabs (projects / files / reports / dashboards), edit/select/delete modes.
- [Profile + Settings page](frontend/redpash-components-pages/profile-page/index.md) — full-bleed 2-step scroll-snap consolidating identity + preferences.

### Auth
- [Google OAuth](auth/google.md) — Phase 4a flow, cookies, session storage, dev_user fallback.

### Internal — RedPash team only

These are team-only and live under `docs/internal/`. Reshaped 2026-05-24
into eight sections — see [internal/index.md](internal/index.md) for
the full map + [internal/redmap.md](internal/redmap.md) for one-page
navigation.

- [Internal index](internal/index.md) — the team-only docs root + lane ownership map.
- [Internal REDMAP](internal/redmap.md) — find anything fast.
- [Code docs](internal/code/index.md) — atomic docs, one per source file under `tools/`, `frontend/scripts/`, `backend/crates/`. Coverage measured by [`tools/doc-coverage-audit`](../tools/doc-coverage-audit/audit.js); spec at [`internal/processes/atomic-doc-plan.md`](internal/processes/atomic-doc-plan.md).
- [Specs](internal/specs/index.md) — the **what**: wire contracts, schemas, surface plans. Source of truth for each wire it describes (audit-ingest, filter DTO, monitoring schemas, optimization map, user prefs, datasource trait, MCP memory bridge, FromRow + WASM-phase-C spikes).
- [Runbooks](internal/runbooks/index.md) — post-mortems of real problems, five parts each: Problem Statement → Troubleshooting steps → RCA → Solution → Post Checking.
- [UI change process](internal/processes/ui-change-process.md) — the standard checklist for every HTML / CSS / JS change.
- [Excel edge-case catalog](internal/excel-edge-cases/index.md) — triage board: 22 dirty multi-sheet `.xlsx` fixtures × 41 edge-case classes.
- [Standup log](internal/standup/index.md) — git-mediated async team standup; one append-only file per contributor.
- [Object model](internal/architecture/object-model.md) — locked 2-entity model (Project + File); the hard-refresh execution plan retired into the architecture spec.

## Reference set

The original Django app lives at `streamlit-proj/clarna-django/md/` —
each markdown file there maps roughly 1:1 to a file in this tree.
Useful as a sanity check when you're porting a feature: if the
Django doc describes a behaviour that's not yet here, that's a
backlog item, not a regression.
