---
title: Charts
section: Features
order: 3
last modified date: 2026-05-21
---

# Charts

Charts attach to a **report** (see [reports.md](reports.md)) and each
one runs its own `/reports/preview` against the report's source file —
independent of the report's table-level grouping. Same code renders
them in the report viewer and embedded in dashboard widgets.

## Architecture

```
ReportSpec.charts: Vec<ChartSpec>
              │
              ▼
       chartPreviewBody(source_file_id, cfg, filter)
              │
              ▼
       POST /api/reports/preview  (4 body shapes — see below)
              │
              ▼
       subtotalsTo<Kind>Series(res)  or  detailsToScatterSeries(res)
              │
              ▼
       chartOption(cfg, …) or chartOption<Kind>(cfg, …)
              │
              ▼
       ECharts.init(host).setOption(opt)
```

All of `chartOption*`, the extractors, and `chartPreviewBody` live in
`scripts/dashboards/chart-render.js`. The Reports page
(`scripts/pages/reports.js`) and the dashboard widget renderer both
import from there.

## ECharts loader

`loadECharts()` (in `scripts/dashboards/echarts.js`) lazy-loads
**ECharts 6** from CDN on first chart mount and registers the `redpash`
theme (palette + tooltips pulled from CSS variables — works in dark
mode too). The `matrix` kind needs the v6 `matrix` coordinate system.

`loadECStat()` lazy-loads `echarts-stat` only when a chart needs a
regression fit. Single-promise shared across concurrent callers.

## Preview body shapes

`chartPreviewBody` dispatches on `cfg.kind`:

| Kind family                                                    | `group_by` sent    | `aggregations` sent                              | Reads back from |
|----------------------------------------------------------------|---------------------|---------------------------------------------------|-----------------|
| `bar` / `bar_horizontal` / `line` / `area` / `pie` / `funnel` / `pictorial_bar` / `calendar` | `[group_by]`        | `[{col, fn, alias: "value"}]`                     | `res.subtotals` |
| `heatmap` / `radar` / `matrix`                                 | `[group_by, y_group_by]` | `[{col, fn, alias: "value"}]`                | `res.subtotals` |
| `boxplot`                                                      | `[group_by]`        | 5 fixed aggs: `min`, `q1`, `median`, `q3`, `max`  | `res.subtotals` |
| `gauge`                                                        | `[]`                | `[{col, fn, alias: "value"}]`                     | `res.subtotals` (1 row) |
| `scatter`                                                      | `[]`                | `[]`                                              | `res.details`   |

## Chart kinds

| Kind             | Visual                          | Data shape                                              | Modifiers (ChartSpec fields)             |
|------------------|---------------------------------|---------------------------------------------------------|------------------------------------------|
| `bar`            | vertical bars                   | `[(label, value)]`                                      | —                                        |
| `bar_horizontal` | horizontal bars                 | `[(label, value)]`, y-axis is the category              | —                                        |
| `line`           | line chart                      | `[(label, value)]`                                      | `smooth`                                 |
| `area`           | line with filled area           | `[(label, value)]`                                      | `smooth`                                 |
| `pie`            | pie / donut / half / rose       | `[(name, value)]`                                       | `donut`, `half`, `rose`                  |
| `funnel`         | stacked stages, widest on top   | `[(name, value)]`                                       | —                                        |
| `gauge`          | speedometer-style single value  | scalar                                                  | (auto-scaled max)                        |
| `pictorial_bar`  | bar with custom symbol          | `[(label, value)]`                                      | `symbol`, `symbol_repeat`                |
| `scatter`        | x/y point cloud                 | `[[x, y], ...]` from raw filtered rows                  | `regression: linear / exponential / logarithmic / polynomial` |
| `heatmap`        | 2D coloured grid                | `[[xIdx, yIdx, value]]` + axis labels                   | requires `y_group_by`                    |
| `radar`          | polygon per series              | `{indicators, series}` (2-dim subtotals)                | requires `y_group_by`                    |
| `boxplot`        | box+whiskers per group          | `[[min, q1, median, q3, max], ...]`                     | (canned 5-agg pipeline)                  |
| `calendar`       | year-grid heatmap               | `[[date, value], ...]`; range auto-picked               | —                                        |
| `matrix`         | ECharts 6 matrix-coord grid     | `[[xIdx, yIdx, value]]` + axis labels                   | requires `y_group_by`; ECharts 6 only    |

Unknown kinds fall back to `bar` via `normalizeKind`.

## Modifiers

### Pie family

- `donut: true` → inner radius 45% (annular).
- `half: true`  → semi-circle (`startAngle: 180, endAngle: 360`).
- `rose: true`  → Nightingale chart, `roseType: "area"`. Slice radius
  scales with value in addition to angle.
- All combine: `half + donut = half donut`; `rose + donut = donut rose`.

### Line / area

- `smooth: true` → spline interpolation.

### PictorialBar

- `symbol`: `circle` / `rect` / `roundRect` / `diamond` / `triangle` /
  `pin` / `arrow` / `path://…`.
- `symbol_repeat: true` → tile the symbol along the bar (dotted look);
  otherwise one stretched symbol per bar.

### Scatter

- `regression: "linear" | "exponential" | "logarithmic" | "polynomial"`
  → fit line via ecStat, appended as a second series. Renders after
  the base chart (ecStat loads async).

## Chart builder → ChartSpec

The Reports page builds charts from a left-rail builder
(`partials/reports/chart-dock.html`) — not a modal. Chart type is a
family `<select>` (`#nc-family`) plus a row of inline-SVG **variant
tiles**; every variant is a tile, there are no modifier checkboxes.

`_CHART_FAMILIES` in `scripts/pages/reports.js` is the registry. A
multi-variant family (bar, line, area, pie, pictorial_bar) carries a
`variants[]` array — each variant commits a `kind` (+ modifiers) to the
active chart and ships an inline-SVG glyph for its tile:

```js
{ key: "pie", label: "Pie", variants: [
  { id: "pie",        label: "Pie",        spec: { kind: "pie" },                g: `<svg…>` },
  { id: "donut",      label: "Donut",      spec: { kind: "pie", donut: true },    g: `<svg…>` },
  { id: "half_donut", label: "Half-donut", spec: { kind: "pie", donut: true, half: true }, g: `<svg…>` },
  { id: "rose",       label: "Rose",       spec: { kind: "pie", rose: true },     g: `<svg…>` },
]}
```

Single-variant families (scatter, heatmap, matrix, radar, boxplot,
calendar, funnel, gauge) have `variants: []` — picked by the `<select>`
alone, no tiles. Applying a variant resets all modifiers first, so
switching never leaves a stale `smooth` / `donut` / `rose` / etc.

## Rollup behaviour (history)

Pre-Phase-A reports rolled up duplicate x labels client-side
(`group: [formule, ville]` plotted as bar of `formule` had to sum the
y per formule). That layer is gone — each chart now does its own
backend aggregation, so duplicate-x cases don't occur. The chart's
`group_by` *is* the x.

## Remaining kinds (parked)

Each of these needs a new data-shape commitment on `ReportSpec` /
`chartPreviewBody` — none of them fit the existing aggregated /
details / two-group-by / scalar pipeline as-is. Pick the one that
matches the next real use case rather than implementing the whole
list speculatively.

| Kind                       | Needed data shape                                      | Notes |
|----------------------------|--------------------------------------------------------|-------|
| **Sankey**                 | `(source, target, value)` flow triples                 | Cleanest of the heavy group. Could reuse the two-group-by pipeline if you allow source ≠ target. |
| **Chord**                  | `(source, target, value)`                              | Same data as Sankey, circular layout. |
| **Tree / Treemap / Sunburst** | `(parent, child, value)` hierarchy                  | One data model unlocks all three. Add a `parent_col` field on `ChartSpec` or build the hierarchy client-side from N group_bys. |
| **Graph (network)**        | Node + link tables (two tables)                        | The current spec has one source frame; this needs two. |
| **Parallel**               | Multi-axis numeric, N columns per row                  | Modal needs a multi-column picker. |
| **ThemeRiver**             | `(time, category, value)`                              | Two-group-by + date axis. Could route through the existing heatmap body shape. |
| **Geo / Map**              | geoJSON region key + value; sometimes pies overlaid    | Needs geoJSON registration + region-name join. `map-iceland-pie` from the official examples is parked here. |
| **Candlestick**            | OHLC per time bucket                                   | Backend needs windowed pre-aggregation (per-period open/high/low/close). |
| **Pie-nest**               | Two pie series at different radii                      | Not really a new kind — second series with inner radius. Could ship as a `nest: bool` modifier on pie. |
| **Bar-rich-text (axis)**   | Per-category icon/image axis labels                    | The current "rich bar" handles data labels; this variant styles the axis category labels (flags / images). |
| **Scatter timeline**       | Time-indexed bubble (life-expectancy variant)          | Needs timeline animation + bubble-size column + per-frame dataset. |

## Adding a new chart kind

1. **chart-render.js**: add to `normalizeKind`, add a `chartOption`
   branch (or a new `chartOption<Kind>` function if the data shape
   differs), plus a `subtotalsTo<Kind>` extractor and the dispatch in
   `chartPreviewBody`.
2. **Backend (only if a new agg fn is needed)**: extend `AggFn` enum in
   `shared::report` and the matching arms in `data::group_by::build_agg_exprs`
   and `default_alias`.
3. **scripts/pages/reports.js**:
   - Add the kind to `_CHART_FAMILIES` — either a new single-variant
     family `{ key, label, variants: [] }`, or a `variants[]` entry
     (with an inline-SVG `g` glyph) under an existing family.
   - Add an `<option value="<kind>">` to `#nc-family` in
     `partials/reports/chart-dock.html`.
   - If the kind needs a new builder field (Y dimension, regression,
     symbol, …), add a `[data-cond-<name>]` row to `chart-dock.html`,
     include it in `_builderFields`, and toggle it in
     `_syncChartConditionals`.
   - Map the kind in `_familyOf` / `_variantOf` if it carries modifiers.
4. **widgets.js**: mirror the chart-render kind dispatch (the dashboard
   widget renderer is a direct copy of the report's chart-mount path).
5. Bump `service-worker.js` `CACHE_VERSION`.
