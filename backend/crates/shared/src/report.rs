//! Purpose: grouping / report-spec DTOs — the shape the group_by engine and
//! chart files speak. There is no stored Report entity (the object-model lock
//! removed it); "Report" is a derived view over a project's chart files.
//! `filter` holds the canonical FilterNode tree as a free-form JSON value.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSpec {
    #[serde(default)]
    pub group_by: Vec<String>,
    /// Column groups (pivot) — row groups × column groups matrix.
    #[serde(default)]
    pub group_by_cols: Vec<String>,
    /// Empty = just unique row counts per group.
    #[serde(default)]
    pub aggregations: Vec<Aggregation>,
    /// A shared::filter::FilterNode applied before the group-by (JSON value).
    #[serde(default)]
    pub filter: Option<serde_json::Value>,
    #[serde(default = "default_true")]
    pub show_details: bool,
    #[serde(default = "default_true")]
    pub show_subtotals: bool,
    #[serde(default)]
    pub show_total: bool,
    /// Applied in order — first is primary, rest are tie-breakers.
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    #[serde(default)]
    pub charts: Vec<ChartSpec>,
    /// Top-N filter on the subtotals output (post-aggregation).
    #[serde(default)]
    pub top_n: Option<TopNFilter>,
    /// Aggregate window functions — derived columns via Polars over().
    #[serde(default)]
    pub windows: Vec<WindowSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSpec {
    pub alias: String,
    /// sum|mean|count|min|max (aggregate) or lag|lead|first_value|last_value (value).
    #[serde(rename = "fn")]
    pub fn_: String,
    pub col: String,
    #[serde(default)]
    pub partition_by: Vec<String>,
    #[serde(default)]
    pub as_percent: bool,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default = "default_offset")]
    pub offset: u32,
}

fn default_offset() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopNFilter {
    pub n: u32,
    pub order_by: String,
    #[serde(default = "default_top_dir")]
    pub direction: String,
    #[serde(default)]
    pub partition_by: Vec<String>,
}

fn default_top_dir() -> String {
    "desc".to_string()
}

/// A chart defined ON a report — its own group-by + aggregation against the
/// report's source file, independent of the report's table grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSpec {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "default_chart_kind")]
    pub kind: String,
    #[serde(default)]
    pub group_by: String,
    #[serde(default = "default_agg_col")]
    pub agg_col: String,
    #[serde(default = "default_agg_fn")]
    pub agg_fn: String,
    #[serde(default)]
    pub smooth: bool,
    #[serde(default)]
    pub donut: bool,
    #[serde(default)]
    pub half: bool,
    #[serde(default)]
    pub rose: bool,
    #[serde(default)]
    pub regression: Option<String>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub symbol_repeat: bool,
    #[serde(default)]
    pub y_group_by: Option<String>,
    #[serde(default)]
    pub rich_labels: bool,
}

fn default_chart_kind() -> String {
    "bar".to_string()
}
fn default_agg_col() -> String {
    "*".to_string()
}
fn default_agg_fn() -> String {
    "count".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SortSpec {
    pub col: String,
    /// "asc" or "desc"; anything else → asc.
    #[serde(default)]
    pub dir: String,
}

impl Default for ReportSpec {
    fn default() -> Self {
        Self {
            group_by: Vec::new(),
            group_by_cols: Vec::new(),
            aggregations: Vec::new(),
            filter: None,
            show_details: true,
            show_subtotals: true,
            show_total: false,
            sort: Vec::new(),
            charts: Vec::new(),
            top_n: None,
            windows: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aggregation {
    pub col: String,
    #[serde(rename = "fn")]
    pub fn_: AggFn,
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
