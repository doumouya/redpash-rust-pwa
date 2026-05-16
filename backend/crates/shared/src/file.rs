//! File (project_files row) DTOs.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSummary {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub filename:           String,
    pub display_name:       Option<String>,
    pub file_type:          String,
    pub stage:              String, // import | clean | report | publish — computed, see file_stages view
    pub row_count:          Option<u64>,
    pub col_count:          Option<u32>,
    pub file_size_bytes:    Option<u64>,
    pub cleanness_pct:      Option<f32>,
    pub encoding:           Option<String>,
    pub delimiter:          Option<String>,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

/// One column in a file's data — name + inferred type + lightweight stats.
///
/// **Two dtype fields**:
/// - `dtype` is the *storage* dtype — what Polars actually parsed the
///   column as. A messy `prix_ht` column with `€1234,56` cells stays
///   `string` because Polars can't natively type the mixed values.
/// - `semantic_dtype` is the *intended* dtype — what the column is
///   trying to be, sniffed from a sample of values by `dtype::summarize`.
///   That same messy `prix_ht` column sniffs as `float`. The cleanness
///   scorer compares the two: a string-stored, float-intended column
///   gets docked proportionally to how many of its values fail a strict
///   native parse — which is exactly the dirt the cleaner pipeline is
///   built to fix (`cast`, `replace_text`, `fix_invalid`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name:       String,
    pub dtype:      String,                   // storage: int | float | date | bool | string | empty
    #[serde(default = "default_semantic_dtype")]
    pub semantic_dtype: String,               // intended: same vocab; defaults to "string" for old rows
    pub null_pct:   Option<f32>,
    pub unique_pct: Option<f32>,
    pub sample:     Option<String>,
}

fn default_semantic_dtype() -> String { "string".into() }

/// Page query — the single endpoint that powers the redtable. Every
/// toolbar interaction (sort, filter, search, page change, column vis,
/// column order) maps to a tweak on these params.
#[derive(Debug, Clone, Deserialize)]
pub struct PageQuery {
    pub page:      Option<u32>,
    pub size:      Option<u32>,
    /// Legacy single-column sort. `sorts` (multi) takes precedence
    /// when present.
    pub sort:      Option<String>,
    pub dir:       Option<String>,            // asc | desc
    /// JSON-encoded array of `{col, dir}` for multi-key sort. Primary
    /// key first; remaining keys break ties.
    pub sorts:     Option<String>,
    pub q:         Option<String>,
    /// JSON-encoded filter spec; decoded server-side.
    pub filters:   Option<String>,
    /// Comma-separated list of visible columns; ordering preserved.
    pub cols:      Option<String>,
}

/// One row in a page response — list of cell values in column order.
pub type Row = Vec<Option<String>>;
