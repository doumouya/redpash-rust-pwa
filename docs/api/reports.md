---
title: Reports (retired)
section: API
order: 99
last modified date: 2026-05-29
---

# `/api/reports/*` — retired

`/api/reports/*` and the standalone `reports` table were retired in mig 016
(`drop_reports`). The page is kept as a stub so old links don't 404 inside
the in-app docs viewer.

## What replaced it

- **Saved charts** — moved to `/api/charts/*`. A "report" used to be a
  rows-table-plus-N-charts compound; the page builder now emits one
  chart-typed `project_files` row per chart (RID prefix `CHT_…`).
  See [charts.md](charts.md) for the resource and
  [objects/chart.md](../objects/chart.md) for the DTO.
- **Filtered / aggregated row views over a csv** — derived directly from
  the source csv-typed file via [`GET /api/files/:rid/page`](files.md#get-apifilesridpage)
  with filters / sorts / column-visibility in the query string. There is
  no persisted "report" row anymore — the redtable is the report.
- **Dashboard widgets** — point at `chart_id: "CHT_…"` instead of
  `report_id: "RPT_…"` + `chart_index`. The compat shim in
  [`dashboards.rs`](../../backend/crates/api/src/routes/dashboards.rs)
  rewrites old widgets on read; the upgrade lands on next save. See
  [dashboards.md](dashboards.md).

## Why the retirement

The old `reports` table mixed two concerns — a rows-view (a csv with
filters / sorts / aggregations) and a charts-view (N chart specs against
that rows-view) — into one persisted row. Em-locked the object model on
2026-05-22 (see [project_object_model](../../../home/mansa/.claude/projects/-home-mansa/memory/project_object_model.md))
to 2 entities — `Project` and `File` — so the rows-view became "the csv
itself, paged through the redtable" and the charts-view became N
first-class chart files. One polymorphic `project_files` table now backs
csv / chart / dashboard with `file_type` as the discriminant — same
one-polymorphic-table pattern the unified `memberships` table applies to
ownership / membership / case-people relationships.

## Migration anchor

| Mig | What it did |
|---|---|
| 016 (`drop_reports`) | Dropped the `reports` table. Chart specs migrated to chart-typed `project_files` rows in the same release. |

## Historical reference

Old `ReportPage` response shape, old `POST /api/reports/preview`,
old report-builder pipeline — moved to the git history. `git log -- backend/crates/api/src/routes/reports.rs`
surfaces the deletion commit and the pre-deletion routes.

---

## Related

- [charts.md](charts.md) — the resource that replaced saved-chart CRUD.
- [files.md](files.md) — paged rows / filtering / aggregation now live here.
- [dashboards.md](dashboards.md) — widgets reference charts directly.
- [objects/chart.md](../objects/chart.md) — the new `Chart` DTO.
