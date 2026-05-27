//! Row-shape cleaning steps: drop by index, drop by predicate(s),
//! drop nulls. Each is a function dispatched from `apply()` in
//! `super`.

use crate::{DataError, Result};
use polars::prelude::*;

use super::util::{arr_strings, build_filter_predicate};

pub(super) fn drop_rows(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let indices: Vec<u32> = params.get("indices")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
        .unwrap_or_default();
    if indices.is_empty() {
        return Err(DataError::InvalidSpec(
            "drop_rows needs params.indices: [int]".into()));
    }
    let n = df.height();
    let mut keep = vec![true; n];
    for i in indices {
        if let Some(slot) = keep.get_mut(i as usize) { *slot = false; }
    }
    let mask: BooleanChunked = keep.into_iter().collect();
    df.filter(&mask).map_err(DataError::from)
}

/// params.combinator: "and" | "or"  (default "and")
/// params.predicates: [{ column, op, value?, case_sensitive? }]
///
/// Each predicate translates to a single Polars Expr; the list is
/// folded with `&` or `|` per combinator, then passed to
/// `df.lazy().filter(combined)`. Empty predicate list is an error
/// (a no-op step would still be persisted to history and that
/// bloats the audit trail). `before` / `after` are string-typed
/// — the value is parsed lazily by Polars when compared against
/// a date column; numeric `lt/gt/etc` cast the value side via
/// `lit().cast(...)` so the predicate works across int / float
/// columns without per-row dtype branching.
pub(super) fn filter_rows(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let combinator = params.get("combinator").and_then(|v| v.as_str()).unwrap_or("and");
    let combine_or = matches!(combinator, "or" | "OR" | "Or");
    let preds = params.get("predicates").and_then(|v| v.as_array())
        .ok_or_else(|| DataError::InvalidSpec(
            "filter_rows needs params.predicates: [{column, op, value?}]".into()))?;
    if preds.is_empty() {
        return Err(DataError::InvalidSpec(
            "filter_rows needs at least one predicate".into()));
    }

    let mut combined: Option<Expr> = None;
    for p in preds {
        let column = p.get("column").and_then(|v| v.as_str())
            .ok_or_else(|| DataError::InvalidSpec(
                "filter_rows predicate missing `column`".into()))?;
        let op = p.get("op").and_then(|v| v.as_str())
            .ok_or_else(|| DataError::InvalidSpec(
                "filter_rows predicate missing `op`".into()))?;
        let case_sensitive = p.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(true);
        let value = p.get("value");

        let expr = build_filter_predicate(column, op, value, case_sensitive)?;
        combined = Some(match combined.take() {
            None       => expr,
            Some(prev) => if combine_or { prev.or(expr) } else { prev.and(expr) },
        });
    }
    let final_expr = combined.expect("predicates non-empty by check above");
    df.lazy().filter(final_expr).collect().map_err(DataError::from)
}

pub(super) fn drop_nulls(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    // No subset → drop rows where ANY column is null.
    // Otherwise → drop rows where ANY listed column is null.
    let cols = arr_strings(params, "cols");
    let lf = df.lazy();
    let collected = if cols.is_empty() {
        lf.drop_nulls(None).collect()
    } else {
        let subset: Vec<Expr> = cols.iter().map(|c| col(c.as_str())).collect();
        lf.drop_nulls(Some(subset)).collect()
    };
    collected.map_err(DataError::from)
}
