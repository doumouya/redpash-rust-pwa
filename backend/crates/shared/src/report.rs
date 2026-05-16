//! Report resource DTOs.
//!
//! A `Report` is the persisted record (id + title + source file +
//! spec). `ReportSpec` is the inner shape — what columns to group by,
//! what aggregations to compute, optional filter to apply first.
//! `ReportRequest` is what the builder POSTs when creating or updating
//! a report.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub source_file_id:     String,
    pub title:              String,
    #[serde(default)]
    pub description:        Option<String>,
    pub spec:               ReportSpec,
    #[serde(default)]
    pub is_favorite:        bool,
    #[serde(default)]
    pub is_public:          bool,
    #[serde(default)]
    pub folder:             Option<String>,
    // Owner — joined in via projects.owner_id → users. None when the
    // fetcher didn't take the users join (e.g. the builder's find_one).
    // The list endpoint populates all three so the Reports tab can show
    // them.
    #[serde(default)]
    pub owner_id:           Option<String>,
    #[serde(default)]
    pub owner_display_name: Option<String>,
    #[serde(default)]
    pub owner_username:     Option<String>,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSpec {
    /// Row groups — drive the leftmost columns of the report.
    #[serde(default)]
    pub group_by:     Vec<String>,
    /// Column groups (pivot). When non-empty the subtotals view
    /// becomes a Salesforce-style matrix: row groups × column groups.
    #[serde(default)]
    pub group_by_cols: Vec<String>,
    /// Aggregations to compute. Empty = just unique row counts per group.
    #[serde(default)]
    pub aggregations: Vec<Aggregation>,
    /// Optional `shared::filter::FilterNode` applied before the group-by.
    /// Serialised as a free-form JSON value so the field can hold either
    /// the tree form or the legacy array form.
    #[serde(default)]
    pub filter:       Option<serde_json::Value>,
    /// Show source rows (no aggregation) — defaults on.
    #[serde(default = "default_true")]
    pub show_details:   bool,
    /// Show per-group aggregated rows — defaults on (the original view).
    #[serde(default = "default_true")]
    pub show_subtotals: bool,
    /// Show grand-total row — defaults off (opt-in, prevents noise).
    #[serde(default)]
    pub show_total:     bool,
    /// Sort list applied to the subtotals/summary result. Sort keys
    /// are applied in order — first entry is the primary sort, the
    /// rest are tie-breakers. Group-by columns not already in the
    /// list are appended as ascending tie-breakers so the visual
    /// hierarchy stays clean.
    #[serde(default)]
    pub sort:           Vec<SortSpec>,
    /// Charts authored alongside this report. Each plots two columns
    /// of the subtotals output. Dashboards reference these by index
    /// (`report_id` + `chart_index`) so the chart definition lives
    /// next to the data shape it depends on.
    #[serde(default)]
    pub charts:         Vec<ChartSpec>,
    /// Optional Top-N filter applied to the *subtotals* output (post-
    /// aggregation). Internally compiles to a ranking window
    /// partitioned by `partition_by` ordered by `order_by`, then
    /// filters to the top N. Use it for "top 5 villes per formule"
    /// style reports without modifying the rest of the spec.
    #[serde(default)]
    pub top_n:          Option<TopNFilter>,
    /// Aggregate window functions — derived columns added to the
    /// subtotals frame. Each entry compiles to a Polars `over()`
    /// expression: `<fn>(col) OVER (PARTITION BY partition_by)`. When
    /// `as_percent` is set, divides the base value by the windowed
    /// total ×100 (turns "partition sum" into "share of partition").
    #[serde(default)]
    pub windows:        Vec<WindowSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSpec {
    /// Name of the derived column.
    pub alias:        String,
    /// Aggregate kinds:    `sum` | `mean` | `count` | `min` | `max`
    /// Value kinds:        `lag` | `lead` | `first_value` | `last_value`
    /// Value kinds require `order_by` to be set; lag/lead also use `offset`.
    #[serde(rename = "fn")]
    pub fn_:          String,
    /// Subtotals column to aggregate (an agg alias or a group-by col).
    pub col:          String,
    /// Partition columns. Empty = global window (broadcasts to every row).
    #[serde(default)]
    pub partition_by: Vec<String>,
    /// Aggregate-window only: divide `col` by the windowed total ×100
    /// to express "share of partition".
    #[serde(default)]
    pub as_percent:   bool,
    /// Value-window only: column to sort each partition by before
    /// applying the shift / first / last. Required for value kinds.
    #[serde(default)]
    pub order_by:     Option<String>,
    /// Lag/lead step. Defaults to 1.
    #[serde(default = "default_offset")]
    pub offset:       u32,
}

fn default_offset() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopNFilter {
    /// How many rows to keep per partition. 0 disables the filter.
    pub n:            u32,
    /// Subtotals column to rank by — typically an aggregation alias.
    pub order_by:     String,
    /// "desc" for top-N (largest first, default) or "asc" for bottom-N.
    #[serde(default = "default_top_dir")]
    pub direction:    String,
    /// Group-by columns to partition within. Empty means a global top N.
    #[serde(default)]
    pub partition_by: Vec<String>,
}

fn default_top_dir() -> String { "desc".to_string() }

/// A chart is a self-contained visualisation defined ON the report.
/// It carries its own group-by + aggregation against the report's
/// source file — independent of the report's table-level grouping —
/// so the user can build many charts with different slicings without
/// having to touch the table view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSpec {
    /// Optional user-visible label.
    #[serde(default)]
    pub title: Option<String>,
    /// `bar` | `bar_horizontal` | `line` | `area` | `pie`. Unknown
    /// values render as bar.
    #[serde(default = "default_chart_kind")]
    pub kind:  String,
    /// Column to group by — becomes the x-axis (category axis) for
    /// bar/line/area/pie and the y-axis for `bar_horizontal`. Empty
    /// string means the chart is unconfigured (the frontend shows a
    /// "configure me" placeholder).
    #[serde(default)]
    pub group_by: String,
    /// Column to aggregate. `*` means count rows; ignored when
    /// `agg_fn == "count"` with `agg_col == "*"`.
    #[serde(default = "default_agg_col")]
    pub agg_col:  String,
    /// Aggregation function applied to `agg_col`:
    /// `count` | `count_distinct` | `sum` | `mean` | `min` | `max`.
    #[serde(default = "default_agg_fn")]
    pub agg_fn:   String,
    /// Smooth-curve interpolation for `line` / `area` kinds. No effect
    /// on bar/pie. Defaults off — straight segments match the raw data
    /// more faithfully.
    #[serde(default)]
    pub smooth:   bool,
    /// Pie modifier: render as a donut (annular ring) instead of solid.
    /// No effect on non-pie kinds. Defaults off.
    #[serde(default)]
    pub donut:    bool,
    /// Pie modifier: half-circle pie (sweeps 180°→360° by default).
    /// Pairs with `donut` to make a half donut. No effect elsewhere.
    #[serde(default)]
    pub half:     bool,
    /// Pie modifier: Nightingale/rose chart — slice radius scales with
    /// value in addition to the angle. No effect on non-pie kinds.
    #[serde(default)]
    pub rose:     bool,
    /// Scatter modifier: overlay a fitted regression line.
    /// `linear` | `exponential` | `polynomial` | `logarithmic` | None.
    /// No effect on non-scatter kinds.
    #[serde(default)]
    pub regression: Option<String>,
    /// PictorialBar modifier: ECharts symbol name (`circle`, `rect`,
    /// `roundRect`, `diamond`, `triangle`, `pin`, `arrow`) or a
    /// `path://…` SVG path string. No effect on non-pictorial kinds.
    #[serde(default)]
    pub symbol:     Option<String>,
    /// PictorialBar modifier: tile the symbol along the bar instead of
    /// stretching one big symbol to the bar's height. Pairs well with
    /// `circle` for a "dotted bar" look.
    #[serde(default)]
    pub symbol_repeat: bool,
    /// Heatmap modifier: second group-by column forming the y-axis
    /// category. Required when `kind == "heatmap"`. The frontend
    /// builds the spec's `group_by = [x_col, y_col]` so the backend
    /// returns rows of `(x_val, y_val, agg_val)`.
    #[serde(default)]
    pub y_group_by:  Option<String>,
    /// Label-styling modifier: switch the chart's data labels to
    /// multi-line styled rich text — for pie, slice label shows
    /// name / value / percent on three lines with different sizes
    /// and weights; for bar, the data label above each bar splits
    /// category + value. No effect on kinds without data labels.
    #[serde(default)]
    pub rich_labels: bool,
}

fn default_chart_kind() -> String { "bar".to_string() }
fn default_agg_col()    -> String { "*".to_string() }
fn default_agg_fn()     -> String { "count".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SortSpec {
    pub col: String,
    /// "asc" or "desc". Anything else falls back to asc.
    #[serde(default)]
    pub dir: String,
}

impl Default for ReportSpec {
    fn default() -> Self {
        Self {
            group_by:       Vec::new(),
            group_by_cols:  Vec::new(),
            aggregations:   Vec::new(),
            filter:         None,
            show_details:   true,
            show_subtotals: true,
            show_total:     false,
            sort:           Vec::new(),
            charts:         Vec::new(),
            top_n:          None,
            windows:        Vec::new(),
        }
    }
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aggregation {
    pub col:   String,
    /// `fn` is reserved in Rust; rename keeps the JSON field readable.
    #[serde(rename = "fn")]
    pub fn_:   AggFn,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AggFn {
    Count,
    CountDistinct,
    Sum,
    Mean,
    Min,
    Max,
    First,
    Last,
    /// 50th percentile (boxplot).
    Median,
    /// 25th percentile (boxplot).
    Q1,
    /// 75th percentile (boxplot).
    Q3,
}

/// Body of `POST /api/reports` (and `PUT /api/reports/:rid`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRequest {
    pub source_file_id: String,
    pub title:          String,
    pub spec:           ReportSpec,
    #[serde(default)]
    pub description:    Option<String>,
    #[serde(default)]
    pub folder:         Option<String>,
}
