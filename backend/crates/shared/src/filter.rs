//! Purpose: THE canonical filter DTO — day-one decision #4.
//!
//! There is exactly ONE filter shape in RedPash-next. It is consumed by:
//!   - `data::parse::page()` (server-side paging)
//!   - the `filter_rows` cleaning step (persisted in project_steps.params)
//!   - `data::group_by` pre-filters (ReportSpec)
//!   - the wasm `apply_filter` wrapper (client-side shaping)
//! The predecessor repo carried a flat Vec spec AND a tree spec; that split
//! was the only reason filter/search could not run client-side in client
//! mode. Never introduce a second shape — extend this one.

use serde::{Deserialize, Serialize};

/// A boolean tree over column predicates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "node", rename_all = "snake_case")]
pub enum FilterNode {
    /// Logical group: `op` is "and" | "or"; empty children = match-all.
    Group { op: GroupOp, children: Vec<FilterNode> },
    /// Leaf predicate on one column.
    Pred {
        col: String,
        op: PredOp,
        /// Comparison value(s); absent for is_null / not_null.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<serde_json::Value>,
        /// Case sensitivity for string ops. Default FALSE (query-time UX
        /// mirrors global search). Persisted cleaning steps that want exact
        /// matching set it explicitly — one field, not two engines.
        #[serde(default)]
        case_sensitive: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PredOp {
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
    In,
    IsNull,
    NotNull,
}

impl FilterNode {
    /// Match-all (the empty filter).
    pub fn all() -> Self {
        FilterNode::Group { op: GroupOp::And, children: Vec::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_nested_tree() {
        let f = FilterNode::Group {
            op: GroupOp::Or,
            children: vec![
                FilterNode::Pred {
                    col: "status".into(),
                    op: PredOp::Eq,
                    value: Some(serde_json::json!("open")),
                    case_sensitive: false,
                },
                FilterNode::Group {
                    op: GroupOp::And,
                    children: vec![FilterNode::Pred {
                        col: "amount".into(),
                        op: PredOp::Gte,
                        value: Some(serde_json::json!(100)),
                        case_sensitive: false,
                    }],
                },
            ],
        };
        let wire = serde_json::to_string(&f).unwrap();
        let back: FilterNode = serde_json::from_str(&wire).unwrap();
        assert_eq!(f, back);
    }
}
