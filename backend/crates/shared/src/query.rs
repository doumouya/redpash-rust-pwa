//! Purpose: THE canonical window query — what reduces and orders the rows for a
//! `/page` window, independent of pagination.
//!
//! `filter` (structured per-column predicates, the filter panel) AND `search`
//! (free-text across every column, the toolbar box) combine, then `sort` orders.
//! ONE shape both surfaces speak: the server POST `/page` body flattens it
//! (+ offset/limit) and the wasm `Workbook.view` parses it. Extend this struct;
//! never grow a second window-query shape (the filter.rs day-one rule).

use serde::{Deserialize, Serialize};

use crate::filter::FilterNode;
use crate::sort::SortKey;

/// The row-shaping half of a page request (pagination lives alongside it on the
/// wire). Every field is optional/empty-defaulted, so `{}` is "the whole frame".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QuerySpec {
    /// Structured per-column predicates (the filter panel). Absent or match-all
    /// = no structured filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterNode>,
    /// Free-text search across every column (the toolbar box). Blank = no search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    /// Column ordering (first key primary). Empty = no sort.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<SortKey>,
}
