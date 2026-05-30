//! Doc: docs/internal/code/backend/data/steps/cells.md
//! Cell-value cleaning steps: single-cell mutation, null-fill,
//! per-column type coercion, full-column case folding,
//! find-and-replace, sentinel→replacement.
//!
//! All preserve the frame's shape; only cell values change.

use std::collections::HashSet;

use crate::{DataError, Result};
use polars::prelude::*;

use super::util::{default_strptime, json_to_string, parse_date_flex, parse_datetime_flex};

pub(super) fn set_cell(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let row = params.get("row").and_then(|v| v.as_u64())
        .ok_or_else(|| DataError::InvalidSpec(
            "set_cell needs params.row: int".into()))? as i64;
    let column = params.get("column").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec(
            "set_cell needs params.column: string".into()))?;
    let height = df.height() as i64;
    if row < 0 || row >= height {
        return Err(DataError::InvalidSpec(
            format!("set_cell row out of range: {row} (df height {height})")));
    }
    // Resolve target column's dtype so the new literal can be
    // cast appropriately before the when/then merge — Polars
    // refuses to mix dtypes inside a single column on collect.
    let dtype = df.column(column).map_err(DataError::from)?.dtype().clone();
    // `value: null` (or missing key) and empty string both mean
    // "clear the cell" — keeps the editor UX intuitive: deleting
    // all text in a contenteditable cell nullifies it.
    let value_opt = params.get("value").and_then(|v| {
        if v.is_null() { None }
        else { Some(json_to_string(v)) }
    });
    let is_blank = value_opt.as_deref().map_or(true, str::is_empty);

    let new_value_expr: Expr = if is_blank {
        lit(NULL).cast(dtype.clone())
    } else {
        lit(value_opt.unwrap()).cast(dtype.clone())
    };

    // Sentinel name for the temporary row-index column — leading
    // underscores keep it from colliding with a real header. Dropped
    // before the collect so the returned frame's shape matches the
    // input.
    const IDX: &str = "__rp_set_cell_idx";
    let mask = col(IDX).eq(lit(row as u32));
    let updated = when(mask)
        .then(new_value_expr)
        .otherwise(col(column));
    df.lazy()
        .with_row_index(IDX, None)
        .with_columns([updated.alias(column)])
        .drop([IDX])
        .collect()
        .map_err(DataError::from)
}

pub(super) fn fill_nulls(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let strategy = params.get("strategy").and_then(|v| v.as_str()).unwrap_or("fixed");
    let one_col = params.get("column").and_then(|v| v.as_str()).map(String::from);
    let value   = params.get("value").map(json_to_string).unwrap_or_default();

    let names: Vec<String> = match &one_col {
        Some(c) => vec![c.clone()],
        None    => df.get_columns().iter().map(|c| c.name().to_string()).collect(),
    };

    let mut exprs: Vec<Expr> = Vec::with_capacity(names.len());
    for name in &names {
        let c = col(name.as_str());
        let filled = match strategy {
            "fixed"   => c.fill_null(lit(value.clone())),
            "zero"    => c.fill_null(lit(0i64)),
            "forward" => c.forward_fill(None),
            other     => return Err(DataError::InvalidSpec(
                format!("unknown fill strategy: {other}"))),
        };
        exprs.push(filled.alias(name.as_str()));
    }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}

pub(super) fn cast(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let column = params.get("column").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("cast needs params.column".into()))?;
    let dtype  = params.get("dtype").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("cast needs params.dtype".into()))?;

    // Take the existing dtype so we can branch: string-source
    // casts to date/datetime/time use multi-format strptime
    // (handles "/", "-", "." separators); other casts fall
    // through to Polars' built-in cast, which is non-strict —
    // unparseable values become null.
    let src_dtype  = df.column(column).map_err(DataError::from)?.dtype().clone();
    let is_str_src = matches!(src_dtype, DataType::String);

    let expr = match dtype {
        "int"      => col(column).cast(DataType::Int64),
        "float"    => col(column).cast(DataType::Float64),
        "str"      => col(column).cast(DataType::String),
        "bool"     => col(column).cast(DataType::Boolean),
        "date"     if is_str_src => parse_date_flex(column),
        "date"                   => col(column).cast(DataType::Date),
        "datetime" if is_str_src => parse_datetime_flex(column),
        "datetime"               => col(column).cast(DataType::Datetime(TimeUnit::Microseconds, None)),
        "time"     if is_str_src => col(column).str().to_time(default_strptime()),
        "time"                   => col(column).cast(DataType::Time),
        other => return Err(DataError::InvalidSpec(format!("unsupported dtype: {other}"))),
    };
    df.lazy().with_columns([expr.alias(column)]).collect().map_err(DataError::from)
}

pub(super) fn change_case(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let mode = params.get("mode").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec(
            "change_case needs params.mode: lower|upper".into()))?;
    let mut exprs: Vec<Expr> = Vec::new();
    for c in df.get_columns() {
        if !matches!(c.dtype(), DataType::String) { continue; }
        let name = c.name().to_string();
        let base = col(name.as_str());
        let transformed = match mode {
            "lower" => base.str().to_lowercase(),
            "upper" => base.str().to_uppercase(),
            // "title" was supported by the Django app but Polars
            // 0.43 omits the helper — wire back in once we have
            // a `map_elements` solution or a newer Polars.
            other   => return Err(DataError::InvalidSpec(
                format!("unsupported change_case mode: {other}"))),
        };
        exprs.push(transformed.alias(name.as_str()));
    }
    if exprs.is_empty() { return Ok(df); }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}

pub(super) fn replace_text(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let column   = params.get("column").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.column".into()))?;
    let find     = params.get("find").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.find".into()))?;
    let replace  = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
    let is_regex = params.get("is_regex").and_then(|v| v.as_bool()).unwrap_or(false);

    let base = col(column).cast(DataType::String);
    let expr = if is_regex {
        base.str().replace_all(lit(find.to_string()), lit(replace.to_string()), false)
    } else {
        base.str().replace_all(lit(find.to_string()), lit(replace.to_string()), true)
    }.alias(column);
    df.lazy().with_columns([expr]).collect().map_err(DataError::from)
}

/// Replace every cell whose value matches one of the listed
/// sentinels with `replacement` (or NULL if absent / null).
/// Two shapes accepted:
///   • new: `{ sentinels: [...], columns?: [...] }` — list of
///     values to replace, applied to the listed columns (or
///     all string columns when omitted). Drives the modal's
///     "found in this file" multi-pick UX.
///   • legacy: `{ column, sentinel }` — single column, single
///     value; preserved so old project_steps rows keep
///     replaying cleanly.
pub(super) fn fix_invalid(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let replacement: Expr = match params.get("replacement") {
        None | Some(serde_json::Value::Null) => lit(LiteralValue::Null),
        Some(serde_json::Value::String(s))   => lit(s.clone()),
        Some(other)                          => lit(other.to_string()),
    };

    // Build the sentinel set — JSON array first, single value as fallback.
    let mut sentinels: Vec<String> = Vec::new();
    if let Some(serde_json::Value::Array(arr)) = params.get("sentinels") {
        for v in arr {
            let s = match v {
                serde_json::Value::String(s)   => s.clone(),
                serde_json::Value::Null         => continue,
                other                           => other.to_string(),
            };
            if !s.is_empty() { sentinels.push(s); }
        }
    }
    if sentinels.is_empty() {
        if let Some(v) = params.get("sentinel") {
            let s = match v {
                serde_json::Value::String(s)   => s.clone(),
                serde_json::Value::Null         => return Err(DataError::InvalidSpec(
                    "fix_invalid needs params.sentinels (or legacy params.sentinel)".into())),
                other                           => other.to_string(),
            };
            if !s.is_empty() { sentinels.push(s); }
        }
    }
    if sentinels.is_empty() {
        return Err(DataError::InvalidSpec(
            "fix_invalid needs params.sentinels (non-empty)".into()));
    }

    // Resolve target columns. Explicit `columns` array wins;
    // legacy `column` next; otherwise every String-typed column.
    let target_cols: Vec<String> = if let Some(serde_json::Value::Array(arr)) = params.get("columns") {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
    } else if let Some(column) = params.get("column").and_then(|v| v.as_str()) {
        vec![column.to_string()]
    } else {
        df.get_columns().iter()
            .filter(|s| matches!(s.dtype(), DataType::String))
            .map(|s| s.name().to_string())
            .collect()
    };
    if target_cols.is_empty() {
        return Err(DataError::InvalidSpec(
            "fix_invalid: no target columns (frame has no string columns)".into()));
    }

    // Validate every target column exists before mutating the frame.
    let known: HashSet<String> = df.get_columns().iter()
        .map(|c| c.name().to_string()).collect();
    for c in &target_cols {
        if !known.contains(c) {
            return Err(DataError::InvalidSpec(
                format!("fix_invalid: unknown column {c:?}")));
        }
    }

    // One expression per target column — when ANY sentinel matches,
    // emit replacement; else keep the original value. Compare
    // cast-to-string so numeric sentinels (`"999"`) still match.
    let mut exprs: Vec<Expr> = Vec::with_capacity(target_cols.len());
    for cname in &target_cols {
        let mut cond: Option<Expr> = None;
        for s in &sentinels {
            let c = col(cname).cast(DataType::String).eq(lit(s.clone()));
            cond = Some(match cond { Some(prev) => prev.or(c), None => c });
        }
        // `unwrap` is safe: sentinels is non-empty (checked above).
        let cond = cond.unwrap();
        exprs.push(when(cond).then(replacement.clone()).otherwise(col(cname)).alias(cname));
    }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}
