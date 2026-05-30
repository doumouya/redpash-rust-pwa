---
title: Charts
section: Features
order: 3
last modified date: 2026-05-30
---

# Charts

A **chart** is a saved view of one CSV File: pick a `group_by` column and
an aggregation, choose a type, and the chart re-runs that grouping every
time it renders. A chart is a `project_files` row (`file_type='chart'`,
`CHT_…` rid); its spec is stored opaquely in `project_files.spec`. See
[objects/chart.md](../objects/chart.md) for the spec fields.

Charts are authored in the **workspace designer** (a lone chart opens on
the designer canvas as a one-tile dashboard) and re-used, unchanged, as
dashboard tiles — see [dashboards.md](dashboards.md).

## Render pipeline

Two layers, both in `scripts/charts/`:

```
chart cfg  ──► buildOption(cfg, theme)  ──► echarts.init(el).setOption(opt)
(build.js)         core option builder
                         ▲
                         │  renderChart(el, spec, theme)   (render.js)
                         └─ wraps buildOption; for non-baked sources it
                            first fetches + synthesizeOption()s the data
```

- **`charts/build.js`** — `buildOption(cfg, t)` is the core translator
  from a chart `cfg` to an ECharts option. It branches on `cfg.kind`
  (the family) and reads its data from `cfg.option` (the option baked at
  save time), falling back to a small placeholder dataset on a fresh
  chart. The **designer** calls `buildOption` directly for workspace +
  dashboard tiles.
- **`charts/render.js`** — `renderChart(el, spec, theme)` wraps
  `buildOption` and adds render-time data fetching for non-baked
  `spec.source` kinds (`resolveData` → `synthesizeOption`). It is the
  mount path for **Home, Settings, and Monitoring** charts (live
  `monitoring-stats` sources); `baked` is the default and skips the
  fetch.

### Where the data comes from

A baked chart gets its data from the designer's **re-aggregation**: the
tile builds a minimal grouping spec from the chart's `group_by` +
`agg_col`/`agg_fn` and POSTs `{ source_file_id, spec }` to
`POST /api/group/preview`, then writes the result into `cfg.option`
(`xAxis.data` + `series[].data`) — the shape `buildOption` reads. There
are **no** `subtotalsTo<Kind>` extractors (those were retired with the old
`widgets.js`).

## ECharts loader

ECharts **5.4.4** is **self-hosted** at `/vendor/echarts/echarts.min.js`
(global `window.echarts`, loaded in `index.html` — no CDN). Prebuilt
Apache themes self-register via `echarts.registerTheme`; the in-house
`redpash-mocha` / `redpash-latte` themes load on demand. `ecStat` is only
pulled in when a feature needs a regression fit.

## Chart types

The type vocabulary lives in `TYPES` (`charts/build.js`). A **type** is
the specific variant the user picks; each maps to a **kind** (the family
`buildOption` branches on, via `TYPE_TO_KIND`):

| Type (`cfg.type`) | Kind (`cfg.kind`) | Visual | Data shape |
|-------------------|-------------------|--------|------------|
| `bar`             | `cartesian`       | vertical bars | `(label, value)` from subtotals |
| `line`            | `cartesian`       | line — `smooth` optional | `(label, value)` |
| `area`            | `cartesian`       | filled line — `smooth` optional | `(label, value)` |
| `barh`            | `barh`            | horizontal bars (category on y) | `(label, value)` |
| `pie`             | `pie`             | pie | `(name, value)` |
| `donut`           | `pie`             | annular pie | `(name, value)` |
| `half_donut`      | `pie`             | semi-circle donut | `(name, value)` |
| `rose`            | `pie`             | Nightingale (radius scales w/ value) | `(name, value)` |
| `scatter`         | `scatter`         | point cloud — **value vs row index** (no paired x/y yet) | `[i, value]` |
| `radar`           | `radar`           | single polygon, one indicator per category | `value[]` |
| `gauge`           | `gauge`           | single-value speedometer | first value (or sum) |
| `pictorial`       | `pictorial`       | bars drawn from repeated symbols | `(label, value)` |

The accordion's **Chart type** section flattens `TYPE_LIST` into one grid,
so any chart can switch to any other type without leaving the picker.
Unknown kinds fall through to the `cartesian` branch.

> **Not implemented.** Earlier docs listed `funnel`, `calendar`,
> `heatmap`, `boxplot`, and `matrix`. `buildOption` has **no branch** for
> these — they don't render. The Rust `ChartSpec` also carries a
> `regression` field, but the scatter branch plots points only; it does
> **not** draw a fitted line. Treat all of these as parked (see below),
> not shipped.

## Modifiers

- **`smooth`** (`line` / `area`) → spline interpolation. Gated by the
  `SMOOTHABLE` set.
- **Pie variants** — `donut` / `half_donut` / `rose` are *types*, not
  boolean flags, in the frontend cfg (they set `cfg.type`); `buildOption`
  reads `cfg.type` to pick radius / `startAngle` / `roseType`.
- **`symbol`** / **`symbol_repeat`** (`pictorial`) → the ECharts symbol
  and whether it tiles along the bar (dotted look) vs stretches one.

## Chart builder

The builder is the right-hand accordion in the designer
(`charts/builder-ui.js` `mountBuilder`), six sections: **Chart type**
(the `TYPE_LIST` grid), **Data** (source file + group-by + measure: agg
fn + col), **Axes**, **Legend**, **Tooltip**, **Style** (theme picker).
Editing group-by / fn / col fires `onDataChange` → the designer
re-aggregates; changing the source file fires `onSourceChange`. The agg
functions offered in the chart UI (`AGG_FNS`): `count`, `count_distinct`,
`sum`, `mean`, `min`, `max`, `median`.

Saving a chart is `POST`/`PUT /api/charts` (a `project_files` row);
deleting is `DELETE /api/charts/:rid`. The chart's last baked ECharts
option rides along in `cfg.option` so it re-renders correctly after a
type/theme switch before the next re-aggregation.

## Themes

`THEMES` (`build.js`) carries both **inline** palettes (we emit explicit
color/text/axis options — `vintage`, `latte`, `mocha`) and **registered**
themes (`registered: true` — `buildOption` goes pass-through and lets the
registered theme drive axis/tooltip/gauge bands: `macarons`, `roma`,
`shine`, `infographic`, `redpash-mocha`, `redpash-latte`, `dark`,
`tech-blue`, `v5`, `gray`).

## Parked kinds (not yet implemented)

Each needs a new data-shape commitment + a `buildOption` branch — pick the
one that matches the next real use case rather than building the whole
list speculatively.

| Kind | Needed data shape | Notes |
|------|-------------------|-------|
| **funnel** | `(name, value)` | Same data as pie; just a `series.type: "funnel"` branch. |
| **heatmap / matrix** | `[[xIdx, yIdx, value]]` + axis labels | Needs a 2-dim group-by (`group_by` + a second column) and a re-aggregation that returns `(x, y, value)` rows. |
| **boxplot** | `[min, q1, median, q3, max]` per group | Re-aggregate with the 5 quantile aggs (the engine already supports `q1`/`median`/`q3`/`min`/`max`). |
| **calendar** | `[[date, value]]` | A date-bucketed group-by + ECharts `calendar` coord. |
| **real scatter** | paired `(x, y)` | Today's scatter plots value-vs-index; true x/y needs a second measure column in the spec. |
| **regression overlay** | base scatter + ecStat fit | The `regression` field exists in the DTO; wire `ecStat` into the scatter branch as a second series. |
| **Sankey / Chord / Tree / Treemap / Sunburst / Graph / ThemeRiver / Geo / Candlestick** | flow triples / hierarchy / OHLC / geoJSON | Heavier — each needs its own data model; most don't fit the single-group-by-plus-agg pipeline. |

## Adding a new chart type

1. **`charts/build.js`** — add a `[type, icon, label]` entry to `TYPES`
   under the right family (a new *variant* of an existing kind), or add a
   new family key **plus** a `buildOption` branch for it (a new ECharts
   shape). Add the type to `SMOOTHABLE` if it's line-like. The accordion's
   Type grid picks up `TYPE_LIST` automatically.
2. **Data shaping** — if the kind needs more than `group_by` + one agg,
   extend the designer's `reaggregate` (`scripts/designer.js`) to build
   the richer grouping spec and bake the right `cfg.option` shape. For
   live (Home/Settings/Monitoring) charts, also handle it in
   `charts/render.js` `synthesizeOption`.
3. **Builder fields** — add any new per-kind controls to the Data section
   in `charts/builder-ui.js`.
4. **Backend (only if a new agg fn is needed)** — extend `AggFn` in
   `shared::report` and the matching arms in `data::group_by`.
5. **`scripts/list-page.js`** — add the kind to `CHART_KINDS` (the
   kind→label map used by the file lists).
