---
title: Dashboards
section: Features
order: 2
---

# Dashboards

A **dashboard** is a layout of widgets — each widget references a chart
authored on a report (or holds a markdown text block). Chart definitions
*live with the report*; the dashboard only decides where they go.

## Layout

Builder at `#/dashboards?id=DSH_…`:

```
┌──────────────────────┬───────────────────┐
│ Preview              │ Dashboard tools   │
│  CSS-grid template   │  template picker  │
│  one cell per slot   │  per-slot editor  │
│  charts mount via    │  (kind + ref)     │
│  ECharts in cells    │                   │
└──────────────────────┴───────────────────┘
```

No source picker. Each chart widget carries its own `report_id +
chart_index`, so different widgets can pull from different reports.

## Templates

Pure CSS-grid `template-areas`, registered in
`scripts/dashboards/templates.js`:

| `template_id`         | Grid                                                    | Slots                                  |
|-----------------------|---------------------------------------------------------|----------------------------------------|
| `1x1`                 | `"main"`                                                | `main`                                 |
| `2x2`                 | `"a b" "c d"`                                           | `a`, `b`, `c`, `d`                     |
| `kpi-row-2x1`         | `"k1 k2 k3" "main-a main-a main-b"`                     | `k1`, `k2`, `k3`, `main-a`, `main-b`   |
| `chart-side-table`    | `"chart side"`                                          | `chart`, `side`                        |
| `header-3x2`          | `"hdr hdr hdr" "a b c" "d e f"`                         | `hdr`, `a`…`f`                         |

Adding a template = one entry. The runtime reads `{columns, rows, areas, slots}`.

> The outer grid container's inline style **must use single quotes**
> (`style='…'`) — `grid-template-areas` contains `"…" "…"` which would
> terminate a double-quoted attribute mid-string and collapse all
> cells to the bottom-right. Lesson learned the hard way.

## Widgets

Two kinds:

```jsonc
// chart — references a saved chart on a report.
{ "slot": "a", "kind": "chart",
  "spec": { "report_id": "RPT_…", "chart_index": 0,
            "title_override": "Q3 funnel" } }

// text — markdown block.
{ "slot": "hdr", "kind": "text",
  "spec": { "markdown": "## Q3 summary\n\nNumbers below." } }
```

Slot editing UI is a `<details>` per slot in the right panel. Each
slot's open/closed state is preserved across re-renders (every modal
input would otherwise collapse the panel — yes, that bug existed once).

## Chart widget render

`renderChart(host, spec)` in `scripts/dashboards/widgets.js`:

1. `getReport(spec.report_id)` — fetched once per session (cached in
   `reportCache`).
2. `report.spec.charts[spec.chart_index]` → the chart's config.
3. `api.post("/reports/preview", chartPreviewBody(report.source_file_id,
   chartCfg, report.spec.filter))` — runs the chart's own group_by + agg
   against the report's source file with the report's filter. Result
   cached per `(report_id, chart_index)` in `chartRunCache`.
4. Extract data with the right helper for the kind (`subtotalsToSeries`
   for category charts; `subtotalsToHeatmap` / `subtotalsToRadar` /
   `subtotalsToBoxplot` / `subtotalsToCalendar` / `detailsToScatterSeries`
   / `subtotalsToScalar` for the rest).
5. Mount via `chartOption(cfg, …)` or `chartOption<Kind>(cfg, …)` — same
   functions the report viewer uses, so a chart looks identical
   embedded vs authored.

Six widgets pointing at the same chart = **one** network call thanks to
the `(report_id, chart_index)` cache.

## DashboardSpec

```jsonc
{
  "template_id": "2x2",
  "widgets": [
    { "slot": "a", "kind": "chart", "spec": { "report_id": "RPT_…", "chart_index": 0 } },
    { "slot": "b", "kind": "chart", "spec": { "report_id": "RPT_…", "chart_index": 2 } },
    { "slot": "c", "kind": "text",  "spec": { "markdown": "..." } }
  ]
}
```

See [objects/dashboard.md](../objects/dashboard.md) for the full DTO.

## Migrating legacy widgets

Dashboards created before the chart-ref refactor (Phase 2 dashboard
rewrite) had `kpi` / `table` / `chart`-with-inline-spec widgets. On
load the controller normalises them:

- `kpi` / `table` → converted to `chart` with empty spec.
- `chart` without `report_id` → spec blanked.

Both end up showing "Pick a report" in the editor and need a one-time
re-config.

## Endpoints

| Method | Path                              | Notes |
|--------|-----------------------------------|-------|
| GET    | `/api/dashboards`                 | List (sorted by folder, favorite, updated_at desc) |
| POST   | `/api/dashboards`                 | Create — body = `DashboardRequest` |
| GET    | `/api/dashboards/:rid`            | Fetch one |
| PUT    | `/api/dashboards/:rid`            | Update |
| DELETE | `/api/dashboards/:rid`            | Remove |
| POST   | `/api/dashboards/:rid/favorite`   | `{value: bool}` |
