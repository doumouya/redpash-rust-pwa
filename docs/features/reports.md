---
title: Reports
section: Features
order: 1
last modified date: 2026-05-30
---

# Reports

A **report** is *not a stored entity* — there is no `reports` table and no
`/api/reports/*` routes. A report is a **derived view**: a
grouping/aggregation spec (`ReportSpec`) run **statelessly** against a CSV
File through `POST /api/group/preview`. The engine persists nothing; the
only thing you can *save* out of the builder is a chart, written as a
chart-typed `project_files` row via `/api/charts/*`.

> Object-model history: the standalone `Report` entity + its CRUD/run
> endpoints were removed in the hard-refresh. "Report" is now a lens over
> a File, not a row. See [`api/reports.md`](../api/reports.md) for the
> retirement note.

## Where it lives

The report builder is a **tab in the workspace filter panel**
(`scripts/report.js` `mountReport`), not a standalone page — the old
`#/reports` route and `scripts/pages/reports.js` are gone. You pick a CSV
file in the workspace, open the **Report** tab, and compose a grouping
question; the preview renders inline in the same panel.

The UI frames the spec as a **"Show me _X_ for each _Y_"** question:
breakdowns are `group_by` chips, measures are aggregations, and an
advanced `<details>` holds pivot / windows / Top-N / show-toggles.

## ReportSpec

```jsonc
{
  "group_by":      ["formule", "ville"],            // row groups (leftmost cols)
  "group_by_cols": [],                              // column groups → matrix pivot
  "aggregations": [
    { "col": "client_id", "fn": "count", "alias": "" }   // col "*" = count of rows
  ],
  "filter":  { "op": "and", "children": [ /* … */ ] },   // FilterNode tree, pre-group
  "show_details":   true,
  "show_subtotals": true,
  "show_total":     false,
  "sort":    [{ "col": "client_id_count", "dir": "desc" }],
  "top_n":   { "n": 5, "order_by": "client_id_count", "direction": "desc", "partition_by": [] },
  "windows": [
    { "alias": "pct", "fn": "sum", "col": "client_id_count",
      "partition_by": ["formule"], "as_percent": true }
  ]
}
```

`ReportSpec` also has a `charts: []` field, but the builder leaves it empty
— charts are authored + saved separately (see [charts.md](charts.md)).

**Aggregation functions** (`AggFn`): `count`, `count_distinct`, `sum`,
`mean`, `min`, `max`, `first`, `last`, `median`, `q1`, `q3`. (The chart
builder offers the common subset; the engine supports all eleven.)

## Pipeline

`data::group_by::execute(df, spec)` runs in this order:

1. **Filter** — `apply_filter(df, spec.filter)` evaluates the `FilterNode`
   tree against the **raw rows**, before any grouping. Skipped when the
   filter JSON is empty/null.
2. **Group + aggregate** — combined keys = `group_by ++ group_by_cols`
   (the matrix split is a frontend concern; Polars sees one group-by). If
   the user grouped but gave no aggregations, an implicit `count(*)` is
   added so the result is never blank.
3. **Windows** — each `WindowSpec` runs as `<fn>(col).over(partition_by)`.
   `as_percent: true` divides by the windowed total ×100. Value windows
   (`lag` / `lead` / `first_value` / `last_value`) sort by `order_by`
   first.
4. **Sort** — eager `DataFrame::sort` over the user's sort spec, with
   `group_by` columns appended as ascending tie-breakers. *Eager, not
   lazy: a `lazy().sort_by_exprs()` chained after `group_by().agg()` has
   been observed to silently drop in some Polars 0.43 builds.*
5. **Top-N** — `sort_by_exprs(order_by) → group_by_stable(partition_by)
   .head(n)` on the post-aggregation frame.

## The engine — `POST /api/group/preview`

Stateless. Request body is exactly:

```jsonc
{ "source_file_id": "FIL_…", "spec": <ReportSpec> }
```

(There is **no** `source_report_id` — the polymorphic "run a named
report's spec, then run this on top" source was removed with the Report
entity.)

The response (`GroupPage`) carries up to three sections plus timing:

| Field        | When populated |
|--------------|----------------|
| `details`    | `show_details: true` — raw filtered rows, sorted by `group_by` (group cols promoted to front so the frontend can rowspan them). **Capped at 1000 rows.** |
| `subtotals`  | Whenever `group_by`, `group_by_cols`, **or** `aggregations` is non-empty. Always *materialized* when grouping is defined; the client decides whether to render it (`show_subtotals`). |
| `total`      | When `group_by` **or** `group_by_cols` is non-empty (grand-total row, group/sort cleared). Client honors `show_total`. |
| `ms`         | Elapsed engine time. |

Each `Section` is `{ columns, rows, total }` where `total = rows.len()`
(no pagination). Rows reuse `shared::file::Row`, so the preview renders
through the same redtable path as the data grid.

> Subtotals/total are materialized by the engine regardless of the
> `show_*` flags — the toggles are display-only. A spec with *only*
> aggregations (no group columns) materializes `subtotals` but **not**
> `total`.

## Filter

The filter panel reuses the cleaner's component — same operators (`eq`,
`neq`, `contains`, `not_contains`, `starts_with`, `ends_with`, `gt`,
`gte`, `lt`, `lte`, `between`, `is_null`, `not_null`) and the same AND/OR
tree. It applies to the **raw rows** before grouping.

## Group by / matrix mode

- **`group_by`** drives the leftmost result columns. Multi-level →
  hierarchical rowspan'd group cells in the details view.
- **`group_by_cols`** turns the subtotals into a Salesforce-style matrix:
  row groups × column groups × first aggregation. The cross-tab pivot is
  done **client-side** (`renderMatrix`) when both `group_by` and the
  pivot dimension are set — the backend still returns long-format rows.

## Sort

`spec.sort: [{ col, dir }, …]` — applied in order, first = primary. Click
a subtotal header to cycle `none → asc → desc → none`; shift-click chains
keys. Empty `{ col: "" }` entries are stripped before sending.

## Top-N per group

A filter on the **post-aggregation** frame. Compiles to:

```
df.lazy()
  .sort_by_exprs([order_by], desc)
  .group_by_stable(partition_by)
  .head(n)
```

`partition_by: []` = global Top-N. When unset and the group depth is > 1,
it defaults to `group_by[..-1]` — so for `[formule, ville]` you get
"top-N villes per formule" with no extra config. `n: 0` disables it;
`direction: "asc"` gives bottom-N.

## Window functions

Two flavours, both edited in the **Window functions** section:

### Aggregate windows
`sum | mean | count | min | max` `OVER (PARTITION BY …)`. Broadcasts one
value across the partition. With `as_percent: true` the derived column is
`col / window_value * 100` — ideal for "share of partition" reports.

### Value windows
`lag | lead | first_value | last_value`. Require an `order_by` column
(sorts the lazy frame first); `lag` / `lead` take an `offset` (default 1).

> `count_distinct` and accurate mean roll-ups can't be reconstructed by
> summing subtotals — add an aggregation against the source instead.

## Preview, undo/redo

The preview is debounced: edits trigger `previewSoon → runPreview`, which
POSTs `{ source_file_id, spec }` to `/group/preview`. Every preview
captures a JSON snapshot into an undo history (capped at 200) — Ctrl/Cmd+Z
undoes, Ctrl/Cmd+Y (or Ctrl/Cmd+Shift+Z) redoes, gated to when the Report
tab is active and you're not typing in a field.

> Engine-bug workaround: when you group without an explicit aggregation,
> the builder injects `{ col: group_by[0], fn: "count" }` rather than
> relying on the implicit count — Polars rejects the literal-count
> expression with "cannot aggregate a literal" in the current build.

## Saving a report as a chart

The builder produces *table* views; it does not persist anything itself.
To keep a view, author it as a **chart** — the chart builder
(`charts/builder-ui.js`) + designer save it via `POST`/`PUT /api/charts`
as a chart-typed `project_files` row (`file_type='chart'`). A saved chart
re-runs its own grouping spec through the same `POST /api/group/preview`
whenever it renders. See [charts.md](charts.md).
