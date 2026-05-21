---
title: Chart
section: Objects
order: 3
last modified date: 2026-05-21
---

# Chart

Inner DTO inside `ReportSpec.charts: Vec<ChartSpec>`. Defined in
`shared::report::ChartSpec`. Each chart runs its own
`/reports/preview` against the parent report's source file — see
[features/charts.md](../features/charts.md) for the rendering pipeline.

## ChartSpec

```rust
pub struct ChartSpec {
    pub title:         Option<String>,
    pub kind:          String,
    pub group_by:      String,          // x dimension (or series for radar/heatmap)
    pub agg_col:       String,          // metric column; "*" for row count
    pub agg_fn:        String,          // count | sum | mean | min | max | …
    pub smooth:        bool,            // line / area
    pub donut:         bool,            // pie
    pub half:          bool,            // pie (semi-circle)
    pub rose:          bool,            // pie (Nightingale)
    pub regression:    Option<String>,  // scatter: linear / exponential / logarithmic / polynomial
    pub symbol:        Option<String>,  // pictorial_bar: circle / rect / triangle / …
    pub symbol_repeat: bool,            // pictorial_bar: tile vs stretch
    pub y_group_by:    Option<String>,  // heatmap / radar: 2nd categorical dim
}
```

## Field reference

| Field            | Type              | Applies to                              | Meaning |
|------------------|-------------------|------------------------------------------|---------|
| `title`          | `Option<String>`  | all                                      | Optional inline title |
| `kind`           | `String`          | required                                 | See [kinds](#kinds) |
| `group_by`       | `String`          | aggregated kinds, heatmap/radar (x), scatter (x), calendar (date) | Empty = unconfigured |
| `agg_col`        | `String`          | aggregated kinds, scatter (y), boxplot (value) | `"*"` for row count |
| `agg_fn`         | `String`          | aggregated kinds                         | Ignored for scatter / boxplot / gauge-grand-total |
| `smooth`         | `bool`            | line / area                              | Spline interpolation |
| `donut`          | `bool`            | pie                                      | Annular ring |
| `half`           | `bool`            | pie                                      | Semi-circle (`startAngle: 180`) |
| `rose`           | `bool`            | pie                                      | Nightingale (`roseType: "area"`) |
| `regression`     | `Option<String>`  | scatter                                  | `linear` / `exponential` / `logarithmic` / `polynomial`; fitted client-side via ecStat |
| `symbol`         | `Option<String>`  | pictorial_bar                            | ECharts symbol name or `path://…` SVG |
| `symbol_repeat`  | `bool`            | pictorial_bar                            | `true` tiles the symbol; `false` stretches one |
| `y_group_by`     | `Option<String>`  | heatmap / radar                          | Y-axis category for heatmap; spokes / indicators for radar |

## Kinds

| `kind`           | Family                  | Reads from `/preview`'s | Requires                            |
|------------------|-------------------------|--------------------------|-------------------------------------|
| `bar`            | aggregated category     | subtotals                | `group_by`, `agg_col`, `agg_fn`     |
| `bar_horizontal` | aggregated category     | subtotals                | same                                |
| `line`           | aggregated category     | subtotals                | same; optional `smooth`             |
| `area`           | aggregated category     | subtotals                | same; optional `smooth`             |
| `pie`            | aggregated single-dim   | subtotals                | same; optional `donut`/`half`/`rose`|
| `funnel`         | aggregated single-dim   | subtotals                | same                                |
| `pictorial_bar`  | aggregated category     | subtotals                | same + `symbol`, `symbol_repeat`    |
| `calendar`       | aggregated by date      | subtotals                | `group_by` = date column, `agg_col`, `agg_fn` |
| `gauge`          | scalar                  | one-row subtotals        | `agg_col`, `agg_fn` (no `group_by`) |
| `scatter`        | raw rows                | details                  | `group_by` (x), `agg_col` (y); optional `regression` |
| `heatmap`        | 2-dim aggregated        | subtotals                | `group_by`, `y_group_by`, agg       |
| `radar`          | 2-dim aggregated        | subtotals                | `group_by` (series), `y_group_by` (indicators), agg |
| `boxplot`        | 5-stat per group        | subtotals (5 cols)       | `group_by`, `agg_col` numeric (agg_fn ignored — runs canned min/q1/median/q3/max) |
| `matrix`         | 2-dim aggregated        | subtotals                | `group_by`, `y_group_by`, agg — renders on the ECharts 6 `matrix` coord system |

Unknown `kind` values fall back to `bar`.

## Wire format example

```jsonc
{
  "title": "Clients per formule",
  "kind":  "bar",
  "group_by": "formule",
  "agg_col":  "client_id",
  "agg_fn":   "count",
  "smooth":   false,
  "donut":    false,
  "half":     false,
  "rose":     false,
  "regression": null,
  "symbol":     null,
  "symbol_repeat": false,
  "y_group_by": null
}
```

Older charts (pre-Phase-A) used `x` / `y` / `agg` (rollup reducer)
fields. Those deserialise to ChartSpecs with empty `group_by` and need
re-configuration via the chart modal.
