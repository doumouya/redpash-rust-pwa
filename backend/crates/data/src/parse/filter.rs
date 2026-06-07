//! Doc: docs/internal/code/backend/data/parse/filter.md
//! Filter expression compilation for `page()` + `apply_filter()`.
//!
//! Decoupled from the CSV-parsing core (`super`) so the per-FilterOp
//! casing rules + tree-collapse + global-search expressions live in one
//! place instead of crowding the parse-pipeline module. Only
//! `apply_filter` is re-exported publicly through `parse`; the rest are
//! `pub(super)` so `page()` in `mod.rs` keeps calling them
//! unqualified-after-`use`.

use crate::{DataError, Result};
use polars::prelude::*;
use shared::filter::{FilterGroup, FilterNode, FilterOp, FilterSpec, GroupOp};

/// Single FilterSpec → Polars Expr.
///
/// Strategy: cast the target column to `String` and compare; lowercase
/// both sides when `f.case_sensitive` is `Some(false)` or absent — the
/// query-time filter has historically defaulted to case-insensitive
/// matching to mirror the global search, and that default stays
/// (existing UIs not passing the flag don't change behavior). When
/// `case_sensitive: Some(true)` is sent (e.g. from a future workspace
/// toggle), both sides are compared as-is. Numeric ops (`gt`, `lt`, …)
/// parse the JSON value as `f64` and let Polars coerce. Null + date
/// ops bypass the casing branch.
fn filter_expr(f: &FilterSpec) -> Result<Expr> {
    let cname = f.col.as_str();
    let raw = col(cname);

    // `case_sensitive` defaults to false (i.e. case-insensitive) on
    // this path to preserve the historical behavior. The steps.rs
    // engine path defaults the same flag to true — the two engines
    // serve different audiences (query-time filter vs persisted
    // cleaning step), so the asymmetric defaults are deliberate.
    // Callers that want either behavior pass the flag explicitly.
    let cs = f.case_sensitive.unwrap_or(false);

    // String column expression — lowercased once when case-insensitive,
    // raw String cast when case-sensitive. Used by every text op below.
    let str_col = if cs {
        raw.clone().cast(DataType::String)
    } else {
        raw.clone().cast(DataType::String).str().to_lowercase()
    };

    let val_str = || -> String {
        match f.value.as_ref() {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        }
    };
    // String-op RHS — lowercased when matching is case-insensitive,
    // verbatim otherwise. Single closure so every text arm uses the
    // same casing decision without branching per-arm.
    let val_op = || -> String {
        let v = val_str();
        if cs {
            v
        } else {
            v.to_lowercase()
        }
    };
    // Lexicographic-range RHS — same casing rule as `val_op` so the
    // Between string-pair fallback stays consistent with Gt/Lt.
    let val_range = |v: Option<&serde_json::Value>| -> String {
        let s = v.and_then(|x| x.as_str()).unwrap_or("").to_string();
        if cs {
            s
        } else {
            s.to_lowercase()
        }
    };
    let val_num = || -> Result<f64> {
        let v = f.value.as_ref().ok_or_else(|| {
            DataError::InvalidSpec(format!(
                "{:?} needs a numeric value on column {cname}",
                f.op
            ))
        })?;
        match v {
            serde_json::Value::Number(n) => n
                .as_f64()
                .ok_or_else(|| DataError::InvalidSpec(format!("non-finite number on {cname}"))),
            serde_json::Value::String(s) => s
                .parse::<f64>()
                .map_err(|_| DataError::InvalidSpec(format!("not numeric on {cname}: {s:?}"))),
            _ => Err(DataError::InvalidSpec(format!(
                "unsupported value type on {cname}"
            ))),
        }
    };
    let val_pair = || -> Result<(f64, f64)> {
        let v = f.value.as_ref().ok_or_else(|| {
            DataError::InvalidSpec(format!("between needs [a, b] on column {cname}"))
        })?;
        let arr = v.as_array().ok_or_else(|| {
            DataError::InvalidSpec(format!("between needs an array on column {cname}"))
        })?;
        if arr.len() != 2 {
            return Err(DataError::InvalidSpec(format!(
                "between needs [a, b] (got {} items)",
                arr.len()
            )));
        }
        let parse = |x: &serde_json::Value| match x {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        };
        Ok((
            parse(&arr[0])
                .ok_or_else(|| DataError::InvalidSpec("between[0] not numeric".into()))?,
            parse(&arr[1])
                .ok_or_else(|| DataError::InvalidSpec("between[1] not numeric".into()))?,
        ))
    };

    // `In` / `NotIn` array values — lowercased on the case-insensitive
    // path, verbatim on the case-sensitive path. Mirrors `val_op`'s
    // single-side casing decision.
    let val_arr_op = || -> Result<Vec<String>> {
        let arr = f.value.as_ref().and_then(|v| v.as_array()).ok_or_else(|| {
            DataError::InvalidSpec(format!("{op:?} on {cname} needs an array value", op = f.op))
        })?;
        Ok(arr
            .iter()
            .map(|v| {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if cs {
                    s
                } else {
                    s.to_lowercase()
                }
            })
            .collect())
    };

    let expr = match f.op {
        FilterOp::Eq => str_col.clone().eq(lit(val_op())),
        FilterOp::Neq => str_col.clone().neq(lit(val_op())),
        FilterOp::In => {
            let needles = val_arr_op()?;
            if needles.is_empty() {
                lit(false) // empty set → nothing matches
            } else {
                needles
                    .into_iter()
                    .map(|n| str_col.clone().eq(lit(n)))
                    .reduce(|a, b| a.or(b))
                    .unwrap()
            }
        }
        FilterOp::NotIn => {
            let needles = val_arr_op()?;
            if needles.is_empty() {
                lit(true) // empty exclusion → everything matches
            } else {
                needles
                    .into_iter()
                    .map(|n| str_col.clone().neq(lit(n)))
                    .reduce(|a, b| a.and(b))
                    .unwrap()
            }
        }
        FilterOp::Contains => str_col.clone().str().contains_literal(lit(val_op())),
        FilterOp::NotContains => str_col.clone().str().contains_literal(lit(val_op())).not(),
        FilterOp::StartsWith => str_col.clone().str().starts_with(lit(val_op())),
        FilterOp::EndsWith => str_col.clone().str().ends_with(lit(val_op())),
        // Range ops: try numeric first; on parse failure, fall back to
        // lexicographic string comparison (works for ISO dates).
        FilterOp::Gt => match val_num() {
            Ok(n) => raw.gt(lit(n)),
            Err(_) => str_col.clone().gt(lit(val_op())),
        },
        FilterOp::Gte => match val_num() {
            Ok(n) => raw.gt_eq(lit(n)),
            Err(_) => str_col.clone().gt_eq(lit(val_op())),
        },
        FilterOp::Lt => match val_num() {
            Ok(n) => raw.lt(lit(n)),
            Err(_) => str_col.clone().lt(lit(val_op())),
        },
        FilterOp::Lte => match val_num() {
            Ok(n) => raw.lt_eq(lit(n)),
            Err(_) => str_col.clone().lt_eq(lit(val_op())),
        },
        FilterOp::Between => {
            if let Ok((a, b)) = val_pair() {
                raw.clone().gt_eq(lit(a)).and(raw.lt_eq(lit(b)))
            } else {
                // String-pair fallback for ISO-date ranges. Uses the
                // same casing rule as the single-value text ops above.
                let arr = f.value.as_ref().and_then(|v| v.as_array()).ok_or_else(|| {
                    DataError::InvalidSpec(format!("between needs [a, b] on column {cname}"))
                })?;
                let a = val_range(arr.get(0));
                let b = val_range(arr.get(1));
                str_col
                    .clone()
                    .gt_eq(lit(a))
                    .and(str_col.clone().lt_eq(lit(b)))
            }
        }
        // Date ops: cast the column + value to Date. Bogus dates cast
        // to NULL and the comparison fails for every row — same loud-
        // fail behavior as the steps.rs engine path. Value side stays
        // verbatim (date strings are case-irrelevant; the casing flag
        // is meaningless here).
        FilterOp::Before => raw
            .clone()
            .cast(DataType::Date)
            .lt(lit(val_str()).cast(DataType::Date)),
        FilterOp::After => raw
            .clone()
            .cast(DataType::Date)
            .gt(lit(val_str()).cast(DataType::Date)),
        FilterOp::IsNull => raw.is_null(),
        FilterOp::NotNull => raw.is_not_null(),
    };
    Ok(expr)
}

/// Apply a JSON filter spec to a DataFrame and return the filtered
/// view. Used by endpoints that need the user's current filter to
/// shape the data they operate on (e.g. joins detect/create).
/// Empty / null JSON returns the frame untouched.
pub fn apply_filter(df: DataFrame, filter_json: &str) -> Result<DataFrame> {
    let trimmed = filter_json.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(df);
    }
    let node = parse_filters(trimmed)?;
    let lf = df.lazy();
    let collected = if let Some(expr) = tree_expr(&node)? {
        lf.filter(expr).collect()
    } else {
        lf.collect()
    };
    collected.map_err(DataError::from)
}

/// Decode the JSON filter spec. Tries the tree form first; on failure
/// falls back to the legacy `Vec<FilterSpec>` (implicit AND).
pub(super) fn parse_filters(json: &str) -> Result<FilterNode> {
    if let Ok(node) = serde_json::from_str::<FilterNode>(json) {
        return Ok(node);
    }
    let leaves: Vec<FilterSpec> =
        serde_json::from_str(json).map_err(|e| DataError::InvalidSpec(format!("filters: {e}")))?;
    Ok(FilterNode::Group(FilterGroup {
        op: GroupOp::And,
        children: leaves.into_iter().map(FilterNode::Leaf).collect(),
    }))
}

/// Recursively turn a FilterNode into a Polars Expr.
/// `Ok(None)` means "no constraint" (e.g. empty AND group); the caller
/// then skips applying any filter rather than wasting an Expr.
pub(super) fn tree_expr(node: &FilterNode) -> Result<Option<Expr>> {
    match node {
        FilterNode::Leaf(spec) => Ok(Some(filter_expr(spec)?)),
        FilterNode::Group(g) => {
            // Empty groups: empty AND = TRUE (no-op), empty OR = FALSE.
            if g.children.is_empty() {
                return Ok(match g.op {
                    GroupOp::And => None,
                    GroupOp::Or => Some(lit(false)),
                });
            }
            let mut acc: Option<Expr> = None;
            for child in &g.children {
                if let Some(ce) = tree_expr(child)? {
                    acc = Some(match (&acc, g.op) {
                        (None, _) => ce,
                        (Some(a), GroupOp::And) => a.clone().and(ce),
                        (Some(a), GroupOp::Or) => a.clone().or(ce),
                    });
                }
            }
            Ok(acc)
        }
    }
}

/// Build a `col1.contains(needle) OR col2.contains(needle) OR …` expr
/// across all string columns. Case-insensitive — both sides are
/// lowercased before the substring test. Returns `None` if the frame
/// has no string columns; the caller then skips the filter.
pub(super) fn search_expr(needle: &str, df: &DataFrame) -> Option<Expr> {
    let lit_needle = lit(needle.to_lowercase());
    let mut acc: Option<Expr> = None;
    for c in df.get_columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        let name = c.name().to_string();
        let part = col(name.as_str())
            .str()
            .to_lowercase()
            .str()
            .contains_literal(lit_needle.clone())
            .fill_null(lit(false));
        acc = Some(match acc {
            None => part,
            Some(a) => a.or(part),
        });
    }
    acc
}
