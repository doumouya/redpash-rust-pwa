//! Purpose: THE canonical sort spec — column ordering for the `/page` window.
//!
//! One sort shape across the stack (the `filter.rs` day-one rule, applied to
//! ordering). It is consumed by:
//!   - `data::sort::apply_sort` (server POST `/page` + the wasm `Workbook`)
//!   - the redtable toolbar's column-header sort (frontend)
//! A `Vec<SortKey>` is a multi-column sort — the first key is primary, ties
//! break on the next — and an empty `Vec` is "no sort" (identity). Never
//! introduce a second sort shape; extend this one.

use serde::{Deserialize, Serialize};

/// One column's sort direction. `descending` defaults to false (ascending), so
/// a bare `{ "col": "amount" }` sorts ascending — the redtable's first click.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortKey {
    pub col: String,
    #[serde(default)]
    pub descending: bool,
}
