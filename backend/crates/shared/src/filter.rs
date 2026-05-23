//! Filter spec — wire format for `PageQuery.filters`.
//!
//! Two shapes are accepted; both serialise as JSON in the query string.
//!
//! Legacy (Vec<FilterSpec>) — implicit AND of leaves:
//! ```json
//! [
//!   { "col": "amount", "op": "gt", "value": 100 },
//!   { "col": "name",   "op": "contains", "value": "foo" }
//! ]
//! ```
//!
//! Tree (FilterNode) — nestable AND / OR:
//! ```json
//! {
//!   "op": "and",
//!   "children": [
//!     { "col": "amount", "op": "gt", "value": 100 },
//!     {
//!       "op": "or",
//!       "children": [
//!         { "col": "country", "op": "eq", "value": "FR" },
//!         { "col": "country", "op": "eq", "value": "BE" }
//!       ]
//!     }
//!   ]
//! }
//! ```
//!
//! `value` is a free-form JSON value because operations need different
//! shapes (string for `contains`, number for `gt`, array for `between`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSpec {
    pub col:   String,
    pub op:    FilterOp,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    /// String-op case sensitivity. `None` means caller didn't say —
    /// engine defaults to `true` to match the historical behavior of
    /// `build_filter_predicate`. Only meaningful for `contains` /
    /// `not_contains` / `starts_with` / `ends_with`; ignored for the
    /// numeric and date ops. Phase-B wasm DTO needs this too — it's
    /// load-bearing for runtime-neutral op specs.
    #[serde(default)]
    pub case_sensitive: Option<bool>,
}

/// Canonical filter ops — the union of:
///   - what the workspace filter UI emits, and
///   - what `data::steps::build_filter_predicate` actually accepts.
///
/// Until 2026-05-23 these drifted in three places:
///   1. `In`, `NotIn` (array membership) lived only in `steps.rs`.
///   2. `Before`, `After` (date comparison) lived only in `steps.rs`.
///   3. `NotContains` lived only in this enum — the predicate engine
///      returned `InvalidSpec` for it. Now implemented as `!contains`.
///
/// Adding variants is wire-additive (`serde(rename_all = "snake_case")`),
/// so callers that don't use them stay green. The Phase-B wasm wrapper
/// reuses this enum verbatim — one DTO, two runtimes; see
/// docs/internal/roadmap-webassembly.md §7 rule 2.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    In,
    NotIn,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    Before,
    After,
    IsNull,
    NotNull,
}

/// One node in the filter tree. Serde tries `Group` first (the `op`
/// field is `and|or`, which doesn't match any `FilterOp`), then falls
/// back to `Leaf`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterNode {
    Group(FilterGroup),
    Leaf(FilterSpec),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterGroup {
    pub op:       GroupOp,
    pub children: Vec<FilterNode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp { And, Or }
