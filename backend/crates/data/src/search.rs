//! Purpose: free-text search → the canonical `FilterNode`. The toolbar's search
//! box is "any column contains <text>", which is just an OR of contains-
//! predicates across every column. So search is NOT a second filter engine: it
//! COMPILES to the one filter shape and rides `filter::apply_filter`. Case-
//! insensitive (the query-path default); a non-matching or null cell simply
//! doesn't win the OR. `effective_filter` AND-combines the structured panel
//! filter with the search so one window can carry both — shared by the server
//! POST `/page` handler and the wasm `Workbook.view`.

use polars::prelude::*;
use serde_json::Value;
use shared::filter::{FilterNode, GroupOp, PredOp};

use crate::Result;

/// Compile `query` into an OR-of-contains `FilterNode` over `columns`. A blank
/// query → match-all (`FilterNode::all()`), so an empty search box is a no-op.
/// Every column is searched (cast to string, case-insensitive by the predicate
/// compiler) — find "20" in a numeric `amount` as readily as "foo" in a name.
pub fn to_filter(columns: &[&str], query: &str) -> FilterNode {
    let q = query.trim();
    if q.is_empty() {
        return FilterNode::all();
    }
    let children = columns
        .iter()
        .map(|c| FilterNode::Pred {
            col: (*c).to_string(),
            op: PredOp::Contains,
            value: Some(Value::String(q.to_string())),
            case_sensitive: false,
        })
        .collect();
    FilterNode::Group { op: GroupOp::Or, children }
}

/// The window's effective row predicate: the structured panel `filter` AND the
/// free-text `search` (compiled over `df`'s columns). A side that is match-all
/// is dropped; if BOTH are match-all the result is `None` (the caller skips the
/// filter roundtrip entirely). The one place the two row-reducers combine —
/// identical on the server and in the browser.
pub fn effective_filter(
    df: &DataFrame,
    filter: Option<&FilterNode>,
    search: Option<&str>,
) -> Option<FilterNode> {
    let mut parts: Vec<FilterNode> = Vec::new();
    if let Some(f) = filter {
        if *f != FilterNode::all() {
            parts.push(f.clone());
        }
    }
    if let Some(q) = search {
        let names: Vec<&str> = df.get_column_names().iter().map(|s| s.as_str()).collect();
        let sf = to_filter(&names, q);
        if sf != FilterNode::all() {
            parts.push(sf);
        }
    }
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(FilterNode::Group { op: GroupOp::And, children: parts }),
    }
}

/// Apply a free-text search directly to a frame (search across all columns).
/// Convenience for a caller that has only a query; `effective_filter` is the
/// composable path the window handlers use.
pub fn apply_search(df: &DataFrame, query: &str) -> Result<DataFrame> {
    match effective_filter(df, None, Some(query)) {
        None => Ok(df.clone()),
        Some(f) => crate::filter::apply_filter(df, &f),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn df5() -> DataFrame {
        crate::parse::from_text(
            "id,name,amount\n1,Alice,10\n2,Bob,20\n3,Carol,200\n4,Bobby,30\n5,Dave,5\n",
        )
        .unwrap()
    }

    #[test]
    fn blank_query_is_match_all() {
        assert_eq!(to_filter(&["a", "b"], "   "), FilterNode::all());
        assert_eq!(apply_search(&df5(), "").unwrap().height(), 5);
    }

    #[test]
    fn searches_every_column_case_insensitive() {
        // "bob" hits name Bob (row 2) + Bobby (row 4), case-insensitive.
        assert_eq!(apply_search(&df5(), "bob").unwrap().height(), 2);
    }

    #[test]
    fn matches_numeric_columns_as_text() {
        // "20" is a substring of amount 20 (row 2) and 200 (row 3) → 2 rows.
        assert_eq!(apply_search(&df5(), "20").unwrap().height(), 2);
    }

    #[test]
    fn effective_filter_ands_filter_and_search() {
        // (amount >= 20 → rows 2,3,4) AND (search "bob" → rows 2,4) → rows 2,4.
        let f = FilterNode::Group {
            op: GroupOp::And,
            children: vec![FilterNode::Pred {
                col: "amount".into(),
                op: PredOp::Gte,
                value: Some(json!(20)),
                case_sensitive: false,
            }],
        };
        let eff = effective_filter(&df5(), Some(&f), Some("bob")).unwrap();
        assert_eq!(crate::filter::apply_filter(&df5(), &eff).unwrap().height(), 2);
    }

    #[test]
    fn both_match_all_is_none() {
        assert!(effective_filter(&df5(), Some(&FilterNode::all()), Some("")).is_none());
        assert!(effective_filter(&df5(), None, None).is_none());
    }
}
