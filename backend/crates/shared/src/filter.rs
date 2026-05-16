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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
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
