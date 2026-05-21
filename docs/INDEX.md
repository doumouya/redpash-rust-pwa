---
title: Documentation index
section: Start here
order: 0
last modified date: 2026-05-21
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
- [Dashboards](features/dashboards.md) — templates + chart-ref widgets.
- [Charts](features/charts.md) — the 13 chart kinds and how they dispatch through `chart-render.js`.

### Objects (DTOs that travel over the wire)
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
- [Me](api/me.md) — `/api/me` + the `resolve_user_rid` spec used everywhere.
- [Auth](api/auth.md) — `/api/auth/google/*` + `/logout` (cookies, errors).
- [Projects](api/projects.md) — `/api/projects` list + `/:rid/files`.
- [Files](api/files.md) — `/api/files/*` upload, page, steps, undo/redo, joins, snapshots.
- [Reports](api/reports.md) — `/api/reports/*` CRUD + preview/run + polymorphic source resolver.
- [Dashboards](api/dashboards.md) — `/api/dashboards/*` CRUD; widgets fetch via `/api/reports`.
- [Events](api/events.md) — `/api/events` runtime observability log — capture middleware + read API.

### Database
- [Schema](db/schema.md) — tables, indexes, RedPash-ID prefix table.
- [RedPash-ID](db/redpash-id.md) — `{PFX}_{32-char uppercase}` format, prefix table, generation code.

### Dev
- [Local setup](dev/setup.md) — prereqs, watch loop, frontend reload.

### Frontend
- [Design tokens](frontend/design.md) — CSS variables, brand, dark mode, library integration + leak-class discipline.
- [Landing page](frontend/redpash-components-pages/landing-page/index.md) — first surface composing `redpash-components`. Hero / float bars / modals / i18n / theme toggle / PWA install / typewriter / shimmer.
- [Home page](frontend/redpash-components-pages/home-page/index.md) — authenticated landing: a single dashboard card (upload zone, minitables, stat strip) linking into /objects.
- [Objects page](frontend/redpash-components-pages/objects-page/index.md) — the browse surface: one redtable, customizable tabs (projects / files / reports / dashboards), edit/select/delete modes.
- [Profile + Settings page](frontend/redpash-components-pages/profile-page/index.md) — full-bleed 2-step scroll-snap consolidating identity + preferences.

### Auth
- [Google OAuth](auth/google.md) — Phase 4a flow, cookies, session storage, dev_user fallback.

### Internal — RedPash team only

- [Runbook index](internal/runbook/index.md) — post-mortems of real problems, five parts each: Problem Statement → Troubleshooting steps → RCA → Solution → Post Checking.
- [0001 — Orphan preferences](internal/runbook/0001-orphan-prefs.md) — Settings controls that persisted a choice no code consumed.
- [Excel edge-case catalog](internal/excel-edge-cases/index.md) — triage board for Workstream 4: 22 dirty multi-sheet `.xlsx` fixtures × 41 edge-case classes (EXL-01…41).
- [Standup log](internal/standup/index.md) — git-mediated async team standup; one append-only file per contributor.

## Reference set

The original Django app lives at `streamlit-proj/clarna-django/md/` —
each markdown file there maps roughly 1:1 to a file in this tree.
Useful as a sanity check when you're porting a feature: if the
Django doc describes a behaviour that's not yet here, that's a
backlog item, not a regression.
