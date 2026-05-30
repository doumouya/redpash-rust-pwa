---
title: Chart
section: Objects
order: 3
last modified date: 2026-05-30
---

# Chart

A saved chart is a `project_files` row (`file_type='chart'`, `CHT_…` rid)
whose JSON spec is stored **opaquely** in `project_files.spec` — the
backend never parses it (`routes::charts` treats it as `serde_json::Value`).

`shared::report::ChartSpec` (below) is the **nominal** Rust DTO — it's the
element type of `ReportSpec.charts: Vec<ChartSpec>` — but the builder
leaves `ReportSpec.charts` empty, so in practice the persisted shape is the
**frontend `cfg`** (the `kind`/`type`/`option`/theme vocabulary in
`scripts/charts/build.js`). Treat the struct below as the field
*reference*; what actually renders is whatever `buildOption` handles. See
[features/charts.md](../features/charts.md) for the render pipeline.

> A chart re-runs its grouping against its `source_file_id` via
> `POST /api/group/preview` (not the retired `/api/reports/preview`).

## ChartSpec

```rust
pub struct ChartSpec {
    pub title:         Option<String>,
    pub kind:          String,          // free-form; doc-comment lists bar|bar_horizontal|line|area|pie, unknown → bar
    pub group_by:      String,          // x dimension; "" = unconfigured
    pub agg_col:       String,          // metric column; "*" for row count
    pub agg_fn:        String,          // count | count_distinct | sum | mean | min | max
    pub smooth:        bool,            // line / area
    pub donut:         bool,            // pie
    pub half:          bool,            // pie (semi-circle)
    pub rose:          bool,            // pie (Nightingale)
    pub regression:    Option<String>,  // scatter — DTO field only, NOT rendered (see note)
    pub symbol:        Option<String>,  // pictorial: circle / rect / triangle / … / path://…
    pub symbol_repeat: bool,            // pictorial: tile vs stretch
    pub y_group_by:    Option<String>,  // 2nd categorical dim — DTO field only, NOT rendered
    pub rich_labels:   bool,            // multi-line styled data labels — DTO field only, NOT rendered
}
```

> **Nominal vs rendered.** The struct carries fields for kinds and
> modifiers the current renderer doesn't implement. `regression`,
> `y_group_by`, and `rich_labels` exist in the DTO but `buildOption`
> ignores them. Don't assume a field renders just because it's here.

## Frontend cfg (what's actually persisted)

The designer edits and saves a `cfg`, not a `ChartSpec`. Key fields
(`charts/build.js`):

- **`type`** — the specific variant the user picked: `bar` · `line` ·
  `area` · `barh` · `pie` · `donut` · `half_donut` · `rose` · `scatter` ·
  `radar` · `gauge` · `pictorial`.
- **`kind`** — the family `buildOption` branches on, derived from `type`
  via `TYPE_TO_KIND`: `cartesian` · `barh` · `pie` · `scatter` · `radar`
  · `gauge` · `pictorial`.
- **`group_by` / `agg_col` / `agg_fn`** — the grouping the tile
  re-aggregates via `/api/group/preview`.
- **`option`** — the last baked ECharts option (so re-renders survive a
  type/theme switch before the next re-aggregation).
- **`smooth` · `symbol` · `symbol_repeat` · `legend` · `legendPos` ·
  `tooltip` · `splitLines` · `axisLine` · `theme`** — chrome + modifiers.

## Rendered kinds

These are the families `buildOption` actually implements:

| `cfg.kind` | Types | Data shape | Notes |
|------------|-------|------------|-------|
| `cartesian` | `bar`, `line`, `area` | `(label, value)` from subtotals | `smooth` on line/area |
| `barh`      | `barh`                | `(label, value)`, category on y | |
| `pie`       | `pie`, `donut`, `half_donut`, `rose` | `(name, value)` | variant set by `type` |
| `scatter`   | `scatter`             | `[index, value]` | value-vs-row-index — no paired x/y yet |
| `radar`     | `radar`               | `value[]`, one indicator per category | single series |
| `gauge`     | `gauge`               | first value (or sum) | single-value KPI |
| `pictorial` | `pictorial`           | `(label, value)` | repeated/stretched `symbol` |

**Not implemented** (no `buildOption` branch — listed in older docs but
they don't render): `funnel`, `calendar`, `heatmap`, `boxplot`, `matrix`.
See the "parked kinds" table in [features/charts.md](../features/charts.md).

## Wire format example

```jsonc
{
  "title": "Clients per formule",
  "type":  "bar",
  "kind":  "cartesian",
  "group_by": "formule",
  "agg_col":  "client_id",
  "agg_fn":   "count",
  "smooth":   false,
  "theme":    "redpash-mocha",
  "option":   { /* last baked ECharts option */ }
}
```
