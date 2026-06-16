//! Purpose: compile THE canonical `shared::FilterNode` tree into a single
//! Polars predicate and apply it to a DataFrame — the one place a filter tree
//! becomes rows. Consumed by BOTH surfaces: the server's POST /page handler
//! (native polars, inside spawn_blocking) and the wasm `Workbook.filter_page`
//! (single-threaded browser). The predicate compiler is NOT duplicated here:
//! every leaf goes through `steps::util::build_filter_predicate`, the same
//! op→Expr match the persisted `filter_rows` step uses. One filter shape, one
//! compiler (day-one decision #4).

use polars::prelude::*;
use shared::filter::{FilterNode, GroupOp, PredOp};

use crate::steps::util::build_filter_predicate;
use crate::{DataError, Result};

/// Apply a `FilterNode` tree to a frame, returning the matching rows.
///
/// An EMPTY group (match-all, `FilterNode::all()`) returns the frame unchanged
/// — no lazy roundtrip, no collect — so paging an unfiltered file is identical
/// to the existing GET page. Otherwise the whole tree compiles to ONE `Expr`
/// and is collected once at the top (`df.lazy().filter(expr).collect()`).
pub fn apply_filter(df: &DataFrame, f: &FilterNode) -> Result<DataFrame> {
    match node_to_expr(f)? {
        // Match-all: hand back the frame as-is (the empty-group fast path).
        None => Ok(df.clone()),
        Some(expr) => df.clone().lazy().filter(expr).collect().map_err(DataError::from),
    }
}

/// A node → its `Expr`. `None` means "match-all" (an empty Group), which the
/// caller short-circuits; it bubbles up so an empty child contributes nothing
/// to its parent's and/or fold rather than forcing a `lit(true)`/`lit(false)`.
fn node_to_expr(node: &FilterNode) -> Result<Option<Expr>> {
    match node {
        FilterNode::Group { op, children } => {
            // Collect each child's expr, skipping match-all children.
            let mut exprs: Vec<Expr> = Vec::with_capacity(children.len());
            for child in children {
                if let Some(e) = node_to_expr(child)? {
                    exprs.push(e);
                }
            }
            // Empty group (or a group whose children are all match-all) is
            // itself match-all.
            if exprs.is_empty() {
                return Ok(None);
            }
            let combined = match op {
                GroupOp::And => exprs.into_iter().reduce(|a, b| a.and(b)),
                GroupOp::Or => exprs.into_iter().reduce(|a, b| a.or(b)),
            }
            .expect("exprs non-empty (checked above)");
            Ok(Some(combined))
        }
        FilterNode::Pred { col, op, value, case_sensitive } => {
            let expr = build_filter_predicate(col, pred_op_str(*op), value.as_ref(), *case_sensitive)?;
            Ok(Some(expr))
        }
    }
}

/// Map the `PredOp` enum to the op string the shared predicate compiler keys
/// on. These strings ARE the persisted `filter_rows` step's `op` field — the
/// enum and the strings are two views of the same vocabulary, pinned here.
fn pred_op_str(op: PredOp) -> &'static str {
    match op {
        PredOp::Eq => "eq",
        PredOp::Neq => "neq",
        PredOp::Contains => "contains",
        PredOp::NotContains => "not_contains",
        PredOp::StartsWith => "starts_with",
        PredOp::EndsWith => "ends_with",
        PredOp::Gt => "gt",
        PredOp::Gte => "gte",
        PredOp::Lt => "lt",
        PredOp::Lte => "lte",
        PredOp::Between => "between",
        PredOp::In => "in",
        PredOp::IsNull => "is_null",
        PredOp::NotNull => "not_null",
    }
}

/// The inverse of `pred_op_str`: an op string → `PredOp`. Used by the flat
/// `filter_rows` step to lift its persisted `{op:"..."}` predicates into the
/// canonical tree before applying. Keeping both directions in this file means
/// the string↔enum mapping has exactly one source of truth. Note `not_in` is
/// accepted by the predicate compiler but has no `PredOp` variant, so the flat
/// step keeps using the compiler directly for it (handled in `filter_rows`).
pub(crate) fn pred_op_from_str(op: &str) -> Result<PredOp> {
    Ok(match op {
        "eq" => PredOp::Eq,
        "neq" => PredOp::Neq,
        "contains" => PredOp::Contains,
        "not_contains" => PredOp::NotContains,
        "starts_with" => PredOp::StartsWith,
        "ends_with" => PredOp::EndsWith,
        "gt" => PredOp::Gt,
        "gte" => PredOp::Gte,
        "lt" => PredOp::Lt,
        "lte" => PredOp::Lte,
        "between" => PredOp::Between,
        "in" => PredOp::In,
        "is_null" => PredOp::IsNull,
        "not_null" => PredOp::NotNull,
        other => return Err(DataError::InvalidSpec(format!("unsupported filter op: {other}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn df5() -> DataFrame {
        crate::parse::from_text(
            "id,status,amount\n1,open,10\n2,closed,20\n3,open,30\n4,closed,40\n5,open,50\n",
        )
        .unwrap()
    }

    #[test]
    fn empty_group_is_match_all_unchanged() {
        let df = df5();
        let out = apply_filter(&df, &FilterNode::all()).unwrap();
        assert_eq!(out.height(), 5);
        assert_eq!(out.get_column_names(), df.get_column_names());
    }

    #[test]
    fn single_pred_filters() {
        let f = FilterNode::Group {
            op: GroupOp::And,
            children: vec![FilterNode::Pred {
                col: "status".into(),
                op: PredOp::Eq,
                value: Some(json!("open")),
                case_sensitive: true,
            }],
        };
        let out = apply_filter(&df5(), &f).unwrap();
        assert_eq!(out.height(), 3);
    }

    #[test]
    fn nested_group_and_or() {
        // (status = open) AND (amount >= 30 OR amount = 10)  →  rows 1, 3, 5
        let f = FilterNode::Group {
            op: GroupOp::And,
            children: vec![
                FilterNode::Pred {
                    col: "status".into(),
                    op: PredOp::Eq,
                    value: Some(json!("open")),
                    case_sensitive: true,
                },
                FilterNode::Group {
                    op: GroupOp::Or,
                    children: vec![
                        FilterNode::Pred {
                            col: "amount".into(),
                            op: PredOp::Gte,
                            value: Some(json!(30)),
                            case_sensitive: false,
                        },
                        FilterNode::Pred {
                            col: "amount".into(),
                            op: PredOp::Eq,
                            value: Some(json!(10)),
                            case_sensitive: false,
                        },
                    ],
                },
            ],
        };
        let out = apply_filter(&df5(), &f).unwrap();
        // status=open → ids 1,3,5 ; of those amount in {10,30,50}: 10(yes),
        // 30(yes,>=30),50(yes,>=30) → all 3.
        assert_eq!(out.height(), 3);
        // `id` parses to i64 (numeric-intent), so read it as such.
        let ids: Vec<Option<i64>> = out.column("id").unwrap().i64().unwrap().iter().collect();
        assert_eq!(ids, vec![Some(1), Some(3), Some(5)]);
    }

    #[test]
    fn empty_nested_child_does_not_poison_parent() {
        // AND( pred(status=closed), empty-group ) → empty group contributes
        // nothing, so this equals just (status=closed) → 2 rows.
        let f = FilterNode::Group {
            op: GroupOp::And,
            children: vec![
                FilterNode::Pred {
                    col: "status".into(),
                    op: PredOp::Eq,
                    value: Some(json!("closed")),
                    case_sensitive: true,
                },
                FilterNode::all(),
            ],
        };
        let out = apply_filter(&df5(), &f).unwrap();
        assert_eq!(out.height(), 2);
    }
}
