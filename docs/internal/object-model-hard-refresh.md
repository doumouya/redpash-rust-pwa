---
title: Object model — hard refresh
section: Hard refresh
order: 0
last modified date: 2026-05-22
---

# Object model — the hard refresh

> **Internal — RedPash team only.** Execution plan for reconciling the
> codebase to the locked object model. Em greenlit it 2026-05-22 ("BYE
> REPORT AND DASHBOARD"). Canonical target:
> [`objects/object-model.md`](../objects/object-model.md). Archive this
> file once Phase 2 lands.

## Why now

The model lived only in conversation, so it drifted. A chart got
persisted two ways — the legacy `reports` table *and* live
`project_files` rows — and `project.stage` was derived off the
`reports` table instead of the files, which is why editing a file
stopped updating the stage. Fixing it now is the cheapest it will ever
be: see the row counts.

## Current-state audit — live DB, 2026-05-22

| Table | Rows | Verdict |
|-------|------|---------|
| `reports`       | **0** | Dead. Drop — free, zero data to migrate. |
| `dashboards`    | **1** | Live. Fold the single row into `project_files`. |
| `project_files` | 32 (31 `csv`, 1 `chart`) | Canonical. Charts-as-files already live. |

**Already matches the target (no work):**

- `project_files` carries `spec` + `source_file_id` + `file_type`
  (`20260530000001_chart_files.sql`).
- The `file_stages` view is already computed off chart-files — it no
  longer references the `reports` table.
- `/api/charts` already persists charts as `project_files` rows.
- None of the 18 step kinds is a "report step" — the "Reports step"
  idea was a phantom.

**Still mismatches the target:**

| Mismatch | Where |
|----------|-------|
| `reports` table + 4 migrations of columns | `20260513…`–`20260516000001_*.sql` |
| `/api/reports` CRUD writes to the dead table | `routes/reports.rs`, `db.rs` |
| `dashboards` is its own entity table | `20260516000001_dashboards.sql`, `routes/dashboards.rs` |
| `file_stages` view still JOINs `dashboards` for the Publish clause | `20260530000001_chart_files.sql` |
| mtime-cascade triggers reference `reports` / `dashboards` | `20260526000001_mtime_cascade.sql`, `20260527000001_dependency_mtime_cascade.sql` |
| `Report` / `ReportSpec` DTOs assume a stored row | `shared::report` |
| `project_files` has no `is_public` / `is_favorite` / `folder` — chart/dashboard files can't be favourited / foldered / published | `20260530000001_chart_files.sql` |
| Docs describe the dead model | `objects/report.md`, `objects/dashboard.md`, `api/reports.md`, `api/dashboards.md`, `db/schema.md`, `REDMAP.md` |

## From → to

| From | To |
|------|----|
| `reports` table | gone — chart-files in `project_files` |
| `RPT_` id | derived label for the `(PRJ_x, file_type='chart')` set |
| `reports.source_file_id` | `project_files.source_file_id` (already on chart-files) |
| `reports.spec` | `project_files.spec` on the chart-file |
| `dashboards` table | `project_files` rows, `file_type='dashboard'` |
| `DSH_` id | derived label for the `(PRJ_x, file_type='dashboard')` set |
| `dashboards.spec` | `project_files.spec` on the dashboard-file |
| `dashboards.is_public` | `project_files.is_public` (new column) |
| `widget.spec.report_id` | `widget.spec.chart_id` (the chart-files migration already uses `chart_id`) |
| `/api/reports` CRUD | gone — `/api/charts` |
| `/api/reports/preview` | **kept** — it is the stateless grouping engine, not a "report". Rename it honest (`/api/group/preview`). |
| `/api/dashboards` CRUD | folded into the unified file API |

## Phasing

### Phase 1 — drop `reports` (now · ~½ day · near-zero risk)

0 rows, nothing to migrate.

- Migration: `DROP TABLE reports`; drop/replace the mtime-cascade
  triggers and functions that reference it.
- `routes/reports.rs`: delete the CRUD handlers; **keep the stateless
  `/preview` grouping engine** — rename the surface honest
  (`/api/group`).
- Remove `reports`-table code from `db.rs`; drop the `Report` DTO's
  stored-row assumptions.
- Lane: backend (Gus). `/api/charts` is already the canonical
  replacement — confirm with Woz that the Reports page is on
  `/api/charts` before deleting anything.

### Phase 2 — fold in `dashboards` (follow-up · ~1 day)

1 row to migrate.

- Migration: add `is_public` (+ `is_favorite`, `folder`) to
  `project_files`; copy the single `dashboards` row in as
  `file_type='dashboard'`; rewire the `file_stages` Publish clause off
  `dashboards`; `DROP TABLE dashboards` + its triggers.
- Retire `/api/dashboards`; serve dashboard-files through the file API.
- Lane: backend (Gus) + frontend (Woz — the Dashboard page reads the
  derived view).

### Phase 3 — sharing (later · the RBAC workstream)

The `shares` table from [`object-model.md`](../objects/object-model.md#sharing-future--rbac-workstream-not-built-yet).
The model after Phases 1–2 is already share-ready; building it now is
premature. Park it.

## Lanes

- **Backend (Gus):** Phase 1 + Phase 2 migrations and route changes.
- **Frontend (Woz):** confirm the Reports page is on `/api/charts`; the
  Dashboard page reads `project_files WHERE file_type='dashboard'`;
  drop any `report_id` / `RPT_` assumptions.
- **Docs (Torv):** rewrite / retire `objects/report.md` +
  `objects/dashboard.md`; update `api/reports.md`, `api/dashboards.md`,
  `db/schema.md`, `REDMAP.md`. **Hold until D3 is ruled.**

## Open: D3

The Publish stage trigger is the one decision still on Em. See the
decision record in
[`object-model.md`](../objects/object-model.md#decision-record). The
docs sync (Torv's lane) waits on this ruling.
