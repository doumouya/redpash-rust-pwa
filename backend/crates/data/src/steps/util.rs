//! Step-engine helpers: JSON-arg extraction, column-keep projection,
//! filter-predicate compilation, date / snake-case utilities.
//!
//! Split out of `steps/mod.rs` so the cleaning-step dispatcher there can
//! stay focused on the per-kind match. All helpers are `pub(super)` —
//! consumed only by the dispatcher, never by external callers.

use crate::{DataError, Result};
use polars::prelude::*;

pub(super) fn arr_strings(params: &serde_json::Value, key: &str) -> Vec<String> {
    params.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

pub(super) fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null      => String::new(),
        other                        => other.to_string(),
    }
}

pub(super) fn select_keep(df: DataFrame, keep: &[String]) -> Result<DataFrame> {
    let refs: Vec<&str> = keep.iter().map(|s| s.as_str()).collect();
    df.select(refs).map_err(DataError::from)
}

/// Build a single Polars `Expr` for one filter_rows predicate.
///
/// Numeric ops cast the value side to Float64 so the comparison works
/// across Int64 / Float64 columns without per-row dtype branching;
/// Polars widens the column side automatically for the comparison.
///
/// String ops cast the COLUMN side to String — guards against the
/// column having drifted to Categorical / Utf8View after a previous
/// step.
///
/// Date ops cast the value to Date (lazy parse via Polars' default
/// strptime). If the value can't be parsed at runtime the filter
/// drops every row (Polars `lit(value).cast(Date)` returns NULL),
/// which is the right behavior — a bogus date filter shouldn't
/// silently keep all rows.
pub(super) fn build_filter_predicate(
    column: &str,
    op: &str,
    value: Option<&serde_json::Value>,
    case_sensitive: bool,
) -> Result<Expr> {
    let c = col(column);
    let need_value = || -> Result<&serde_json::Value> {
        value.ok_or_else(|| DataError::InvalidSpec(
            format!("filter_rows op `{op}` needs a value")))
    };
    let val_string = || -> Result<String> { Ok(json_to_string(need_value()?)) };
    let val_f64    = || -> Result<f64> {
        let v = need_value()?;
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .ok_or_else(|| DataError::InvalidSpec(
                format!("filter_rows op `{op}` needs a numeric value")))
    };
    let val_array  = || -> Result<Vec<String>> {
        let v = need_value()?;
        v.as_array()
            .map(|a| a.iter().map(json_to_string).collect())
            .ok_or_else(|| DataError::InvalidSpec(
                format!("filter_rows op `{op}` needs an array value")))
    };

    Ok(match op {
        "eq"  => c.cast(DataType::String).eq(lit(val_string()?)),
        "neq" => c.cast(DataType::String).neq(lit(val_string()?)),

        "in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(false)   // empty set → nothing matches
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter()
                    .map(|v| s.clone().eq(lit(v)))
                    .reduce(|a, b| a.or(b))
                    .unwrap()
            }
        }
        "not_in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(true)    // empty exclusion → everything matches
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter()
                    .map(|v| s.clone().neq(lit(v)))
                    .reduce(|a, b| a.and(b))
                    .unwrap()
            }
        }

        "contains" => {
            let pat = val_string()?;
            // case_sensitive=false → lowercase both sides. Simpler than
            // the str.contains literal=false branch, and works for the
            // Utf8View string type Polars uses internally.
            if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase()
                    .str().contains_literal(lit(pat.to_lowercase()))
            }
        }
        // Symmetric inverse of `contains` — same case-sensitivity
        // semantics, negated predicate. Reconciles the long-standing
        // shared::FilterOp::NotContains variant the UI could already
        // emit (the engine previously returned InvalidSpec for it).
        "not_contains" => {
            let pat = val_string()?;
            let inner = if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase()
                    .str().contains_literal(lit(pat.to_lowercase()))
            };
            inner.not()
        }
        "starts_with" => c.cast(DataType::String).str().starts_with(lit(val_string()?)),
        "ends_with"   => c.cast(DataType::String).str().ends_with(lit(val_string()?)),

        // Numeric comparisons. Cast the value to Float64; Polars widens
        // the column side as needed.
        "gt"  => c.gt (lit(val_f64()?)),
        "gte" => c.gt_eq(lit(val_f64()?)),
        "lt"  => c.lt (lit(val_f64()?)),
        "lte" => c.lt_eq(lit(val_f64()?)),

        "between" => {
            // value must be a 2-element array [low, high], inclusive.
            let arr = need_value()?.as_array().ok_or_else(|| DataError::InvalidSpec(
                "filter_rows op `between` needs value: [low, high]".into()))?;
            if arr.len() != 2 {
                return Err(DataError::InvalidSpec(
                    "filter_rows op `between` needs exactly two endpoints".into()));
            }
            let parse = |v: &serde_json::Value| -> Result<f64> {
                v.as_f64()
                    .or_else(|| v.as_i64().map(|n| n as f64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .ok_or_else(|| DataError::InvalidSpec(
                        "filter_rows op `between` endpoints must be numeric".into()))
            };
            let lo = parse(&arr[0])?;
            let hi = parse(&arr[1])?;
            c.clone().gt_eq(lit(lo)).and(c.lt_eq(lit(hi)))
        }

        // Date ops — value side parsed by Polars lazily. Bogus date
        // strings cast to NULL and the comparison fails for every row,
        // which is the right behavior (loud failure beats silent keep).
        "before" => c.cast(DataType::Date)
                     .lt(lit(val_string()?).cast(DataType::Date)),
        "after"  => c.cast(DataType::Date)
                     .gt(lit(val_string()?).cast(DataType::Date)),

        "is_null"  => c.is_null(),
        "not_null" => c.is_not_null(),

        other => return Err(DataError::InvalidSpec(
            format!("unsupported filter_rows op: {other}"))),
    })
}

pub(super) fn default_strptime() -> StrptimeOptions {
    StrptimeOptions { format: None, strict: false, exact: false, cache: true }
}

/// Try several common date layouts and take the first that parses.
/// Polars' default `cast(Date)` only accepts ISO `YYYY-MM-DD`, so
/// strings like `2021/02/16` or `16/02/2021` would otherwise become null.
pub(super) fn parse_date_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y",
        "%d-%m-%Y", "%d.%m.%Y", "%Y%m%d",
    ];
    let exprs: Vec<Expr> = FORMATS.iter()
        .map(|f| col(column).str().to_date(StrptimeOptions {
            format: Some((*f).into()),
            strict: false, exact: true, cache: true,
        }))
        .collect();
    coalesce(&exprs)
}

pub(super) fn parse_datetime_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
        "%Y/%m/%d %H:%M:%S", "%d/%m/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M",    "%d/%m/%Y %H:%M",
    ];
    let exprs: Vec<Expr> = FORMATS.iter()
        .map(|f| col(column).str().to_datetime(
            None,
            None,
            StrptimeOptions {
                format: Some((*f).into()),
                strict: false, exact: true, cache: true,
            },
            lit("raise"),
        ))
        .collect();
    coalesce(&exprs)
}

/// Header → snake_case. Trims, lowercases, splits CamelCase boundaries,
/// collapses runs of `[ -.]` to a single `_`.
pub(super) fn snake_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_lower_or_digit = false;
    for ch in s.trim().chars() {
        if ch.is_uppercase() && prev_lower_or_digit {
            out.push('_');
        }
        match ch {
            ' ' | '-' | '.' | '/' => out.push('_'),
            c => out.extend(c.to_lowercase()),
        }
        prev_lower_or_digit = ch.is_lowercase() || ch.is_ascii_digit();
    }
    // Collapse runs of underscores + trim.
    let mut collapsed = String::with_capacity(out.len());
    let mut last_us = false;
    for ch in out.chars() {
        if ch == '_' {
            if !last_us && !collapsed.is_empty() {
                collapsed.push('_');
            }
            last_us = true;
        } else {
            collapsed.push(ch);
            last_us = false;
        }
    }
    collapsed.trim_matches('_').to_string()
}
