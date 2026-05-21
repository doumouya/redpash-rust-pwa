---
title: Reports
section: Features
order: 1
last modified date: 2026-05-21
---

# Reports

A **report** is a saved query over a CSV: group rows, aggregate values,
optionally filter, optionally pivot into a matrix, optionally trim with
a Top-N filter, optionally enrich with window-function columns,
optionally plot charts. All authored from one page.

## Layout

The Reports page (`#/reports?project=PRJ_…&file=FIL_…`,
`scripts/pages/reports.js`) is a sandbox-ported page — a vertical
scroll-snap deck of two full-bleed pages, with a page-dots rail to
jump between them:

```
Page 1 — Data                     Page 2 — Charts
┌─────────────────────────────┐   ┌──────────┬──────────────────────┐
│ proj-tabs / header /        │   │ builder  │ chart dock           │
│ file-tabs / toolbar         │   │ rail     │  one card per chart; │
│ ┌─────────────────────────┐ │   │ (edits   │  the active card     │
│ │ source redtable         │ │   │  active  │  redraws live        │
│ │ (read-only) + pager     │ │   │  chart)  │                      │
│ └─────────────────────────┘ │   │          │                      │
└─────────────────────────────┘   └──────────┴──────────────────────┘
```

- **Page 1 "Data"** — workspace chrome (project tabs, header,
  source-file tabs, toolbar) over the **read-only** source redtable.
  Reports never mutate the source; the toolbar's filter can scope the
  rows a chart sees.
- **Page 2 "Charts"** — a left **builder rail** + the **chart dock**.
  The builder edits the *active* chart; its dock card redraws live as
  fields change.

## ReportSpec

The saved JSON shape (see `objects/report.md` for the full DTO):

```jsonc
{
  "group_by":      ["formule", "ville"],
  "group_by_cols": [],                              // matrix pivot dimension
  "aggregations": [
    { "col": "client_id", "fn": "count", "alias": "" }
  ],
  "filter":  { "op": "and", "children": [...] },    // FilterNode tree
  "sort":    [{ "col": "client_id_count", "dir": "desc" }],
  "show_details":   true,
  "show_subtotals": true,
  "show_total":     false,
  "top_n":   { "n": 5, "order_by": "client_id_count", "direction": "desc", "partition_by": [] },
  "windows": [
    { "alias": "pct", "fn": "sum", "col": "client_id_count",
      "partition_by": ["formule"], "as_percent": true }
  ],
  "charts":  [ /* ChartSpec */ ]
}
```

## Pipeline

`data::group_by::execute(df, spec)` runs in this order:

1. **Filter** — `apply_filter(df, spec.filter)` evaluates the
   `FilterNode` tree against raw rows.
2. **Group + aggregate** — combined keys = `group_by + group_by_cols`;
   if `aggregations` is empty but the user grouped, an implicit
   `count(*)` is added so the result is never blank.
3. **Sort** — eager `DataFrame::sort` over the user's sort spec, with
   `group_by` columns appended as ascending tie-breakers. *Eager,
   not lazy, because chained `lazy().sort_by_exprs()` after
   `group_by().agg()` has been observed to silently drop in some
   Polars 0.43 builds.*
4. **Windows** — each `WindowSpec` runs as `<fn>(col).over(partition_by)`
   added with `.with_columns()`. `as_percent: true` divides by the
   windowed total ×100. Value windows (`lag` / `lead` / `first_value`
   / `last_value`) sort the lazy frame by `order_by` first.
5. **Top-N** — `sort_by_exprs(order_by) → group_by_stable(partition_by)
   .head(n)`. `partition_by: []` defaults to `group_by[..-1]` so for
   `[formule, ville]` you get "top-N villes per formule" automatically.

The response (`/reports/preview` and `/reports/:rid/run`) carries three
sections:

| Field         | When populated                                  |
|---------------|-------------------------------------------------|
| `details`     | `show_details: true` — raw filtered rows, capped at 1000. Sorted by `group_by` so the frontend can rowspan group cells. |
| `subtotals`   | Always materialized when grouping is defined. The viewer respects `show_subtotals` to hide it. |
| `total`       | Always materialized when grouping is defined. The viewer respects `show_total` to hide it. |

> Subtotals + total are *always materialized* even when the viewer
> hides them, because dashboards and the HTML export read from the
> same `/reports/:rid/run` response. Display toggles live in the
> viewer, not in the engine.

## Filter

Filter panel is mounted from the cleaner module — same component, same
operators (`eq`, `neq`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `gt`, `gte`, `lt`, `lte`, `between`, `is_null`,
`not_null`) and the same AND/OR tree.

The filter applies to the **raw rows** before grouping. Charts on the
report share the same filter — see [charts.md](charts.md).

## Group by / matrix mode

- **`group_by`** drives the leftmost columns of the result. Multi-level
  → hierarchical rowspan'd group cells in the details view.
- **`group_by_cols`** turns the subtotals into a Salesforce-style
  matrix: row groups × column groups × first aggregation. Detected
  client-side when `group_by_cols.length > 0 && group_by.length > 0`.

## Sort

`spec.sort: [{ col, dir }, ...]` — applied in order. Click subtotal
headers to cycle `none → asc → desc → none`; shift-click adds keys to
the chain. The frontend strips empty `{ col: "" }` entries before
sending (cheap defence against stale state).

## Top-N per group

Inline filter on the post-aggregation frame. UI is in the Report tools
panel under **Top N per group**. Compiles to:

```
df.lazy()
  .sort_by_exprs([order_by], desc)
  .group_by_stable(partition_by)
  .head(n)
```

`partition_by` empty = global top N. Default = `group_by[0..-1]` so the
common case ("top N of the deepest group per outer group") needs no
config.

## Window functions

Two flavours, both edited in the **Window functions** section:

### Aggregate windows
`sum | mean | count | min | max` `OVER (PARTITION BY …)`.
Broadcasts a single value across the partition. When `as_percent` is
set the derived column is `col / window_value * 100` — perfect for
"share of partition" reports.

### Value windows
`lag | lead | first_value | last_value`. Require an `order_by` column
(sorts the lazy frame first). `lag` / `lead` take an `offset` (default 1).

> `count_distinct` and accurate mean roll-ups aren't covered by the
> Phase B/B.1 windows — both produce wrong results if you sum
> subtotals. Add an aggregation against the source instead.

## Charts page

Page 2 is the chart workspace. Each chart runs its **own**
`/reports/preview` against its source file with its own `group_by` +
agg — see [charts.md](charts.md).

- **Builder rail** — family `<select>` + variant tiles + the data
  fields (group-by, metric, aggregator, per-kind conditionals). Edits
  the active chart; the matching dock card redraws live.
- **Chart dock** — one card per chart. Each card header has
  Save / Download / Remove; the builder footer carries the master
  Save / Download / Delete acting on the active chart.
- **Save** stamps a title + description (auto-named `chart-NNN` when a
  card is active and the field is blank) and flags the chart saved.
- **Download** exports the chart as a standalone HTML report — the
  rendered ECharts SVG wrapped with its title + description.

### Persistence (current)

Saved charts are written to `localStorage['rp_saved_charts_v1']`, keyed
per project — they survive a reload and are restored into the dock on
mount. This is a **stopgap**: the eventual model persists a saved chart
as a `FIL_` html File (so it surfaces on the Objects page and the
Dashboard page can read it). Drafts stay in-memory only.

## Endpoints

| Method | Path                                | Notes |
|--------|-------------------------------------|-------|
| GET    | `/api/reports`                      | List all (sorted by folder, favorite, updated_at desc) |
| POST   | `/api/reports`                      | Create — body = `ReportRequest` |
| POST   | `/api/reports/preview`              | Run a spec without saving — `{source_file_id, spec}` or `{source_report_id, spec}` |
| GET    | `/api/reports/:rid`                 | Fetch one |
| PUT    | `/api/reports/:rid`                 | Update |
| DELETE | `/api/reports/:rid`                 | Remove |
| POST   | `/api/reports/:rid/run`             | Run the saved spec — same response shape as `/preview` |
| POST   | `/api/reports/:rid/favorite`        | `{value: bool}` |

The `/preview` endpoint accepts a polymorphic source:

- `source_file_id: "FIL_…"` → run the widget's spec against the raw
  source file's frame.
- `source_report_id: "RPT_…"` → run the **named report's** spec first,
  then run the widget's spec *on top of* the resulting subtotals.
  Lets dashboards consume an already-aggregated report.
