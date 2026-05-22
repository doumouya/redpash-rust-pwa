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
invoice. A project is a folder; the Designer and Publisher views are
folder-like groupings — none of them is the thing inside.

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

A project's chart set and dashboard set are **derived views**, never
stored:

| View | Definition |
|------|------------|
| the **Designer** view  | `project_files WHERE project_redpash_id = X AND file_type = 'chart'` |
| the **Publisher** view | `project_files WHERE project_redpash_id = X AND file_type = 'dashboard'` |

## Stage — computed, never stored

`project.stage` is a pure function of the project's files. This is the
fix for the bug Em hit: stage was derived *some other way* (a
`reports`-table check), so editing a file no longer updated the stage.
Make stage a function of the files and there is nothing to keep in
sync — it is always correct by construction.

Project stage = the furthest-along milestone present among its files:

| Stage       | Reached when the project has… |
|-------------|-------------------------------|
| **Publish** | ≥1 *public* dashboard-file |
| **Design**  | ≥1 chart-file |
| **Clean**   | ≥1 file with ≥1 cleaning step |
| **New**     | files uploaded, nothing else done (default) |

Stages mark the *furthest surface reached*, not a mandatory sequence. A
project can reach **Design** without ever passing through **Clean** —
import an already-clean file and go straight to charting. Like a
spreadsheet: opening it just to sort one table doesn't mean you must
use every feature (Em).

There is **no cleaning step on the Designer.** The Designer *builds
charts*; it is not a cleaning surface. Cleaning steps (`project_steps`)
are recorded only by the Cleaner. So "edits on the Designer's table
don't persist as steps" is correct by design, not a bug — the fix
there is making the Designer's data cells visibly read-only so they
don't look editable.

## Surfaces

Each work stage has exactly one workspace:

| Stage       | Surface       | What you do there |
|-------------|---------------|-------------------|
| New         | *(upload)*    | a file exists, untouched |
| Clean       | **Cleaner**   | apply cleaning steps |
| Design      | **Designer**  | build charts |
| Publish     | **Publisher** | compose and publish dashboards |

## Chart → Dashboard link

The link lives in the **dashboard's** `spec`:
`spec.widgets[].spec.chart_id`. Nothing on the chart points up. A chart
can therefore sit on any number of dashboards at zero schema cost —
many-to-many, for free.

## Sharing (future — RBAC workstream, not built yet)

A share is a *grant*, stored in a future `shares` table — not a
property of the shared thing:

`(grantee, project_id, scope, file_id?, role)`,
`scope ∈ {project, charts, dashboards, file}`.

"Share my charts, not my CSVs" = a grant with `scope = charts`. This is
the exact use Em had in mind for `RPT_` / `DSH_` — and it needs a *new*
table, not the old ones kept on life support. A derived `RPT_` / `DSH_`
label is a perfectly fine share target. Parked until the RBAC
workstream.

## Decision record

| #  | Decision | Status |
|----|----------|--------|
| D1 | Report & Dashboard are derived views — no table, no stored id | **Locked** (Em, 2026-05-22) |
| D2 | Chart↔dashboard link lives in the dashboard `spec` (`chart_id`s); many-to-many; nothing on the chart | **Locked** — the `file_stages` view already keys on this shape |
| D3 | Publish stage trigger | **Locked** — Em ruled (a), 2026-05-22: **Publish = the project has ≥1 *public* dashboard-file.** Matches the word "publish"; already what the `file_stages` view computes; needs only a per-dashboard "make public" toggle. |
| D4 | Word lock — the three work surfaces are **Cleaner / Designer / Publisher**. "Report" is retired entirely: not an entity, not a stage, not a surface. A chart is a **Chart**; a dashboard is a **Dashboard**. | **Locked** (Em, 2026-05-22) |
| D5 | A dashboard is a `project_files` row (`file_type='dashboard'`), not its own table | **Locked** target — folded in by the migration |
| D6 | Pipeline stages renamed: Import→**New**, **Clean**, Report→**Design**, **Publish**. Stages mark the furthest surface reached, not a forced sequence. | **Locked** (Em, 2026-05-22) |

## What this does NOT touch

The entity layer is thin. The compute algorithms — encoding detection,
parse, unwrap, auto-clean, cleanness scoring, joins, group-by, export —
operate on Polars `DataFrame`s and never see the entity layer. They
cannot be affected by this refresh. The hard part of RedPash is safe.

## See also

- [Project](project.md) · [File](file.md) · [Chart](chart.md) · [Step](step.md)
- Execution plan: [`internal/object-model-hard-refresh.md`](../internal/object-model-hard-refresh.md)
