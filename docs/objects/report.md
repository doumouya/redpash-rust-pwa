---
title: Report
section: Objects
order: 1
---

# Report

Persisted row in the `reports` table. Source: `shared::report::Report`
and `shared::report::ReportSpec`.

## Report

| Field                 | Type                  | Notes |
|-----------------------|-----------------------|-------|
| `redpash_id`          | `String` (`RPT_…`)    | Primary key |
| `project_redpash_id`  | `String`              | FK → `projects.redpash_id` |
| `source_file_id`      | `String`              | FK → `project_files.redpash_id` |
| `title`               | `String`              | |
| `description`         | `Option<String>`      | |
| `spec`                | [`ReportSpec`](#reportspec) | Persisted as JSONB |
| `is_favorite`         | `bool`                | |
| `is_public`           | `bool`                | Phase 4 — toggled to make the report accessible via its RID without login |
| `folder`              | `Option<String>`      | Free-form label for organisation |
| `created_at`          | `DateTime<Utc>`       | |
| `updated_at`          | `DateTime<Utc>`       | |

## ReportSpec

The inner JSONB shape. All fields default sensibly so older specs
deserialise unchanged.

```rust
pub struct ReportSpec {
    pub group_by:       Vec<String>,
    pub group_by_cols:  Vec<String>,
    pub aggregations:   Vec<Aggregation>,
    pub filter:         Option<serde_json::Value>,  // FilterNode tree
    pub show_details:   bool,   // viewer-side
    pub show_subtotals: bool,   // viewer-side
    pub show_total:     bool,   // viewer-side
    pub sort:           Vec<SortSpec>,
    pub charts:         Vec<ChartSpec>,
    pub top_n:          Option<TopNFilter>,
    pub windows:        Vec<WindowSpec>,
}
```

| Field            | Notes |
|------------------|-------|
| `group_by`       | Row group dimensions. Multi-level → hierarchical rowspan. |
| `group_by_cols`  | Pivot dimension — turns the subtotals into a matrix. |
| `aggregations`   | See [Aggregation](#aggregation). Empty + non-empty `group_by` → implicit `count(*)`. |
| `filter`         | `FilterNode` tree (untagged: Group/AND-OR or Leaf comparison). Applied before grouping. |
| `show_details`   | Viewer toggle. Backend still computes details when requested via `/preview`. |
| `show_subtotals` | Viewer toggle. **Always materialized server-side** when grouping is defined. |
| `show_total`     | Viewer toggle. Always materialized when grouping is defined. |
| `sort`           | Applied after agg. Eager `DataFrame::sort` (not lazy — see below). |
| `charts`         | See [chart.md](chart.md). |
| `top_n`          | See [TopNFilter](#topnfilter). |
| `windows`        | See [WindowSpec](#windowspec). |

> `sort` was made eager because chained `lazy().sort_by_exprs()` after
> `group_by().agg()` silently dropped sorts in some Polars 0.43 builds.

## Aggregation

```rust
pub struct Aggregation {
    pub col:   String,         // "*" for row count
    pub fn_:   AggFn,          // serialized as "fn"
    pub alias: Option<String>, // defaults to "{col}_{fn}" or just "{fn}" for "*"
}
```

`AggFn` JSON values (`snake_case`):
`count` | `count_distinct` | `sum` | `mean` | `min` | `max` | `first`
| `last` | `median` | `q1` | `q3`.

The last three (`median`, `q1`, `q3`) are wired through Polars
`base.quantile(lit(0.25 | 0.75), QuantileInterpolOptions::Linear)`
and exist primarily for the boxplot chart kind's canned 5-stat
pipeline.

## SortSpec

```rust
pub struct SortSpec {
    pub col: String,
    pub dir: String,   // "asc" or "desc" (anything else falls back to asc)
}
```

Frontend strips `{ col: "" }` entries before sending — defence against
stale state from legacy reports.

## TopNFilter

```rust
pub struct TopNFilter {
    pub n:            u32,
    pub order_by:     String,         // subtotal column to rank by
    pub direction:    String,         // "desc" (default) or "asc"
    pub partition_by: Vec<String>,    // empty = global; falls back to group_by[..-1]
}
```

Compiles to `sort_by_exprs(order_by) → group_by_stable(partition_by)
→ head(n)`.

## WindowSpec

```rust
pub struct WindowSpec {
    pub alias:        String,
    pub fn_:          String,         // serialized as "fn"
    pub col:          String,
    pub partition_by: Vec<String>,    // empty = global window
    pub as_percent:   bool,           // aggregate kinds only
    pub order_by:     Option<String>, // required for value kinds
    pub offset:       u32,            // lag/lead step (default 1)
}
```

Allowed `fn` values:

**Aggregate** — broadcast a partition-wide value to every row:
`sum` | `mean` | `count` | `min` | `max`.
With `as_percent: true`, the derived column is `col / window_value * 100`.

**Value** — compare each row against its partition (require `order_by`):
`lag` | `lead` | `first_value` | `last_value`. `lag` / `lead` also use
`offset` (default 1).

## ChartSpec

Full reference in [objects/chart.md](chart.md).

## Request body

```rust
pub struct ReportRequest {
    pub source_file_id: String,
    pub title:          String,
    pub spec:           ReportSpec,
    pub description:    Option<String>,
    pub folder:         Option<String>,
}
```
