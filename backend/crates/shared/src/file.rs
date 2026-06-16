//! Purpose: file/column wire DTOs — the shapes the quality report and the
//! redtable speak. Both the api (native) and data (wasm) crates produce these.

use serde::{Deserialize, Serialize};

/// Per-column metadata: the storage dtype Polars parsed vs the SEMANTIC dtype
/// the column intends to be (sniffed from samples). The cleanness scorer docks
/// columns where the two disagree, proportional to cells failing a strict parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// storage: int | float | date | bool | string | empty
    pub dtype: String,
    /// intended: same vocabulary; defaults to "string" for old rows.
    #[serde(default = "default_semantic_dtype")]
    pub semantic_dtype: String,
    pub null_pct: Option<f32>,
    pub unique_pct: Option<f32>,
    pub sample: Option<String>,
}

fn default_semantic_dtype() -> String {
    "string".into()
}
