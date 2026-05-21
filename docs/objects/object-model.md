---
title: Object model
section: Objects
order: 0
last modified date: 2026-05-22
---

# Object model

The canonical RedPash object model. **Locked by Em on 2026-05-22**
("THANKS TEAM! BYE REPORT AND DASHBOARD!!!") after a three-agent design
review (Woz, Gus, Torv all converged). This supersedes every earlier
draft. The per-object pages in this section describe the *shape* of
each DTO; this page is the *contract* they all answer to.

## The two entities

Only two things are stored:

- **Project** (`PRJ_`) — a folder. Owns files. One id, minted once at
  creation.
- **File** (`FIL_`) — every artifact is a row in the one
  `project_files` table. A `file_type` tags it (`csv`, `chart`,
  `dashboard`, …); `source_file_id` is the edge back to the file it was
  produced from — the lineage DAG.

Plus the cleaner's per-file transform history: **Step**
(`project_steps`, `STP_`).

Em's analogy: a real-world folder named *"invoices"* is not itself an
invoice. "Project", "Report", "Dashboard" are folders — containers —
not the things inside them.

### File types

| `file_type` | What it is | `spec` holds | `source_file_id` |
|-------------|------------|--------------|------------------|
| `csv`       | uploaded / joined / snapshot data | `{}` | the file it derives from, or `NULL` for an upload |
| `chart`     | a saved chart — ECharts `option` + SVG snapshot | the chart definition | its data file |
| `dashboard` | a layout composing charts | the widget layout (lists `chart_id`s) | `NULL` |

A chart is a File. A dashboard is a File. Export artifacts (png, xlsx,
html, json) are just files with a `file_type` — "a File is a File"
(Em).

## What is NOT an entity

- **No `reports` table. No `dashboards` table.**
- **No `RPT_` / `DSH_` ids.** `RPT_999` / `DSH_999` are at most
  *derived labels* for `PRJ_999`'s chart / dashboard sets —
  URL-addressable, never stored as a key that can drift from the
  project id.
- **No `report_id` / `dashboard_id` column on a chart.**

"Report" and "Dashboard" are **derived views** over a project's files:

| View | Definition |
|------|------------|
| a project's **Report**    | `project_files WHERE project_redpash_id = X AND file_type = 'chart'` |
| a project's **Dashboard** | `project_files WHERE project_redpash_id = X AND file_type = 'dashboard'` |

## Stage — computed, never stored

`project.stage` is a pure function of the project's files. This is the
fix for the bug Em hit: stage was derived *some other way* (a
`reports`-table check), so editing a file no longer updated the stage.
Make stage a function of the files and there is nothing to keep in
sync — it is always correct by construction.

Project stage = the furthest-along milestone present among its files:

| Stage       | Reached when the project has… |
|-------------|-------------------------------|
| **Publish** | ≥1 *public* dashboard-file — *(D3, see decision record)* |
| **Report**  | ≥1 chart-file |
| **Clean**   | ≥1 file with ≥1 cleaning step |
| **Import**  | files, nothing else done (default) |

There is **no "Report step".** The Reports page *builds charts* — it is
not a cleaning surface. Cleaning is the Cleaner's job, and cleaning
steps are the only thing recorded in `project_steps`. "Edits on the
Reports table don't persist as steps" is therefore correct by design,
not a bug. (The real fix there is making the Reports data cells visibly
read-only so they don't look editable.)

## Chart → Dashboard link

The link lives in the **dashboard's** `spec`:
`spec.widgets[].spec.chart_id`. Nothing on the chart points up. A chart
can therefore sit on any number of dashboards at zero schema cost —
many-to-many, for free.

## Sharing (future — RBAC workstream, not built yet)

A share is a *grant*, stored in a future `shares` table — not a
property of the shared thing:

`(grantee, project_id, scope, file_id?, role)`,
`scope ∈ {project, report, dashboard, file}`.

"Share my charts, not my CSVs" = a grant with `scope = report`. This is
the exact use Em had in mind for `RPT_` / `DSH_` — and it needs a *new*
table, not the old ones kept on life support. A derived `RPT_` / `DSH_`
label is a perfectly fine share target. Parked until the RBAC
workstream.

## Decision record

| #  | Decision | Status |
|----|----------|--------|
| D1 | Report & Dashboard are derived views — no table, no stored id | **Locked** (Em, 2026-05-22) |
| D2 | Chart↔dashboard link lives in the dashboard `spec` (`chart_id`s); many-to-many; nothing on the chart | **Locked** — the `file_stages` view already keys on this shape |
| D3 | Publish stage trigger | **Open — Em to rule.** Recommended: **≥1 *public* dashboard-file** (matches the word "publish"; already what the `file_stages` view computes; needs only a per-dashboard "make public" toggle, not the full `shares` table). Alternative: ≥1 dashboard-file exists at all (model uniformity — every other stage is "a file type is present"). |
| D4 | Word lock: "Report" = the folder/view; the artifact inside is a **Chart** — never "report" for a chart | **Locked** |
| D5 | A dashboard is a `project_files` row (`file_type='dashboard'`), not its own table | **Locked** target — folded in by the migration |

## What this does NOT touch

The entity layer is thin. The compute algorithms — encoding detection,
parse, unwrap, auto-clean, cleanness scoring, joins, group-by, export —
operate on Polars `DataFrame`s and never see the entity layer. They
cannot be affected by this refresh. The hard part of RedPash is safe.

## See also

- [Project](project.md) · [File](file.md) · [Chart](chart.md) · [Step](step.md)
- Execution plan: [`internal/object-model-hard-refresh.md`](../internal/object-model-hard-refresh.md)
