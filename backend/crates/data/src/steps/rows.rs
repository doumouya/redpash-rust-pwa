//! Purpose: row-shape cleaning steps — drop by index, drop by predicate(s),
//! drop nulls. Each is undoable like every other step; the canonical CSV
//! stays intact.

use polars::prelude::*;
use shared::filter::{FilterNode, GroupOp};

use super::util::arr_strings;
use crate::filter::{apply_filter, pred_op_from_str};
use crate::{DataError, Result};

pub(super) fn drop_rows(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let indices: Vec<u32> = params
        .get("indices")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
        .unwrap_or_default();
    if indices.is_empty() {
        return Err(DataError::InvalidSpec("drop_rows needs params.indices: [int]".into()));
    }
    let n = df.height();
    let mut keep = vec![true; n];
    for i in indices {
        if let Some(slot) = keep.get_mut(i as usize) {
            *slot = false;
        }
    }
    let mask: BooleanChunked = keep.into_iter().collect();
    df.filter(&mask).map_err(DataError::from)
}

/// params.combinator: "and" | "or" (default "and");
/// params.predicates: [{ column, op, value?, case_sensitive? }].
///
/// The persisted flat shape is lifted into THE canonical `FilterNode` tree (a
/// single Group with the combinator + the predicates as children) and applied
/// through `crate::filter::apply_filter` — so there is one filter engine, and
/// a `filter_rows` step and a query-time `/page` filter compile through the
/// exact same code. The flat params are still ACCEPTED so persisted steps
/// replay unchanged (the day-one "one filter shape" promise).
pub(super) fn filter_rows(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let combinator = params.get("combinator").and_then(|v| v.as_str()).unwrap_or("and");
    let op = if matches!(combinator, "or" | "OR" | "Or") { GroupOp::Or } else { GroupOp::And };
    let preds = params
        .get("predicates")
        .and_then(|v| v.as_array())
        .ok_or_else(|| DataError::InvalidSpec("filter_rows needs params.predicates".into()))?;
    if preds.is_empty() {
        return Err(DataError::InvalidSpec("filter_rows needs at least one predicate".into()));
    }
    let mut children: Vec<FilterNode> = Vec::with_capacity(preds.len());
    for p in preds {
        let column = p
            .get("column")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DataError::InvalidSpec("filter_rows predicate missing `column`".into()))?;
        let op_str = p
            .get("op")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DataError::InvalidSpec("filter_rows predicate missing `op`".into()))?;
        // Persisted steps default case_sensitive to TRUE (exact matching);
        // the FilterNode wire default is FALSE — so the flat step pins it
        // explicitly rather than relying on the DTO default.
        let case_sensitive = p.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(true);
        let value = p.get("value").cloned();
        children.push(FilterNode::Pred {
            col: column.to_string(),
            op: pred_op_from_str(op_str)?,
            value,
            case_sensitive,
        });
    }
    let tree = FilterNode::Group { op, children };
    apply_filter(&df, &tree)
}

pub(super) fn drop_nulls(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let cols = arr_strings(params, "cols");
    let lf = df.lazy();
    let collected = if cols.is_empty() {
        lf.drop_nulls(None).collect()
    } else {
        let subset = by_name(cols.iter().map(|c| c.as_str()), true, false);
        lf.drop_nulls(Some(subset)).collect()
    };
    collected.map_err(DataError::from)
}
