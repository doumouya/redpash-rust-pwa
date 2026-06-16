//! Purpose: cell-value cleaning steps — single-cell set, null-fill, locale-
//! aware cast (FR number/bool/multi-format date coercion), case folding,
//! find-and-replace, and sentinel→replacement. Shape is preserved; only
//! values change.

use std::collections::HashSet;

use polars::prelude::*;

use super::util::{
    default_strptime, json_to_string, normalize_bool_cell, normalize_numeric_cell, parse_date_flex,
    parse_datetime_flex,
};
use crate::{DataError, Result};

pub(super) fn set_cell(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let row = params
        .get("row")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| DataError::InvalidSpec("set_cell needs params.row: int".into()))? as i64;
    let column = params
        .get("column")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("set_cell needs params.column".into()))?;
    let height = df.height() as i64;
    if row < 0 || row >= height {
        return Err(DataError::InvalidSpec(format!("set_cell row out of range: {row}")));
    }
    let dtype = df.column(column).map_err(DataError::from)?.dtype().clone();
    let value_opt = params.get("value").and_then(|v| if v.is_null() { None } else { Some(json_to_string(v)) });
    let is_blank = value_opt.as_deref().map_or(true, str::is_empty);
    let new_value_expr: Expr = if is_blank {
        lit(NULL).cast(dtype.clone())
    } else {
        lit(value_opt.unwrap()).cast(dtype.clone())
    };
    const IDX: &str = "__rp_set_cell_idx";
    let mask = col(IDX).eq(lit(row as u32));
    let updated = when(mask).then(new_value_expr).otherwise(col(column));
    df.lazy()
        .with_row_index(IDX, None)
        .with_columns([updated.alias(column)])
        .drop(cols([IDX]))
        .collect()
        .map_err(DataError::from)
}

pub(super) fn fill_nulls(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let strategy = params.get("strategy").and_then(|v| v.as_str()).unwrap_or("fixed");
    let one_col = params.get("column").and_then(|v| v.as_str()).map(String::from);
    let value = params.get("value").map(json_to_string).unwrap_or_default();
    let names: Vec<String> = match &one_col {
        Some(c) => vec![c.clone()],
        None => df.columns().iter().map(|c| c.name().to_string()).collect(),
    };
    let mut exprs: Vec<Expr> = Vec::with_capacity(names.len());
    for name in &names {
        let c = col(name.as_str());
        let filled = match strategy {
            "fixed" => c.fill_null(lit(value.clone())),
            "zero" => c.fill_null(lit(0i64)),
            "forward" => c.fill_null_with_strategy(FillNullStrategy::Forward(None)),
            other => return Err(DataError::InvalidSpec(format!("unknown fill strategy: {other}"))),
        };
        exprs.push(filled.alias(name.as_str()));
    }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}

pub(super) fn cast(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let column = params
        .get("column")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("cast needs params.column".into()))?;
    let dtype = params
        .get("dtype")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("cast needs params.dtype".into()))?;
    let src_dtype = df.column(column).map_err(DataError::from)?.dtype().clone();
    let is_str_src = matches!(src_dtype, DataType::String);

    // Locale-aware numeric coercion — the single biggest cleanliness gap.
    if is_str_src && matches!(dtype, "int" | "float") {
        let ca = df.column(column).map_err(DataError::from)?.str().map_err(DataError::from)?;
        let floats: Vec<Option<f64>> = ca.iter().map(|o| o.and_then(normalize_numeric_cell)).collect();
        let series = Series::new(column.into(), floats);
        let new_col = if dtype == "int" {
            series.cast(&DataType::Int64).map_err(DataError::from)?
        } else {
            series
        };
        let mut out = df;
        out.with_column(new_col.into_column()).map_err(DataError::from)?;
        return Ok(out);
    }

    // Locale-aware boolean coercion (EN+FR).
    if is_str_src && dtype == "bool" {
        let ca = df.column(column).map_err(DataError::from)?.str().map_err(DataError::from)?;
        let bools: Vec<Option<bool>> = ca.iter().map(|o| o.and_then(normalize_bool_cell)).collect();
        let series = Series::new(column.into(), bools);
        let mut out = df;
        out.with_column(series.into_column()).map_err(DataError::from)?;
        return Ok(out);
    }

    let expr = match dtype {
        "int" => col(column).cast(DataType::Int64),
        "float" => col(column).cast(DataType::Float64),
        "str" => col(column).cast(DataType::String),
        "bool" => col(column).cast(DataType::Boolean),
        "date" if is_str_src => parse_date_flex(column),
        "date" => col(column).cast(DataType::Date),
        "datetime" if is_str_src => parse_datetime_flex(column),
        "datetime" => col(column).cast(DataType::Datetime(TimeUnit::Microseconds, None)),
        "time" if is_str_src => col(column).str().to_time(default_strptime()),
        "time" => col(column).cast(DataType::Time),
        other => return Err(DataError::InvalidSpec(format!("unsupported dtype: {other}"))),
    };
    df.lazy().with_columns([expr.alias(column)]).collect().map_err(DataError::from)
}

pub(super) fn change_case(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("change_case needs params.mode: lower|upper".into()))?;
    let mut exprs: Vec<Expr> = Vec::new();
    for c in df.columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        let name = c.name().to_string();
        let base = col(name.as_str());
        let transformed = match mode {
            "lower" => base.str().to_lowercase(),
            "upper" => base.str().to_uppercase(),
            other => return Err(DataError::InvalidSpec(format!("unsupported change_case mode: {other}"))),
        };
        exprs.push(transformed.alias(name.as_str()));
    }
    if exprs.is_empty() {
        return Ok(df);
    }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}

pub(super) fn replace_text(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let column = params
        .get("column")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.column".into()))?;
    let find = params
        .get("find")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.find".into()))?;
    let replace = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
    let is_regex = params.get("is_regex").and_then(|v| v.as_bool()).unwrap_or(false);
    let base = col(column).cast(DataType::String);
    // literal flag is the inverse of is_regex.
    let expr = base
        .str()
        .replace_all(lit(find.to_string()), lit(replace.to_string()), !is_regex)
        .alias(column);
    df.lazy().with_columns([expr]).collect().map_err(DataError::from)
}

/// Replace cells matching one of the listed sentinels with `replacement`
/// (or NULL). New shape `{ sentinels: [...], columns?: [...] }`; legacy
/// `{ column, sentinel }` still replays.
pub(super) fn fix_invalid(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let replacement: Expr = match params.get("replacement") {
        None | Some(serde_json::Value::Null) => lit(NULL),
        Some(serde_json::Value::String(s)) => lit(s.clone()),
        Some(other) => lit(other.to_string()),
    };
    let mut sentinels: Vec<String> = Vec::new();
    if let Some(serde_json::Value::Array(arr)) = params.get("sentinels") {
        for v in arr {
            match v {
                serde_json::Value::String(s) if !s.is_empty() => sentinels.push(s.clone()),
                serde_json::Value::Null => {}
                serde_json::Value::String(_) => {}
                other => sentinels.push(other.to_string()),
            }
        }
    }
    if sentinels.is_empty() {
        if let Some(v) = params.get("sentinel") {
            match v {
                serde_json::Value::String(s) if !s.is_empty() => sentinels.push(s.clone()),
                serde_json::Value::Null => {
                    return Err(DataError::InvalidSpec(
                        "fix_invalid needs params.sentinels (or legacy params.sentinel)".into(),
                    ))
                }
                other => sentinels.push(other.to_string()),
            }
        }
    }
    if sentinels.is_empty() {
        return Err(DataError::InvalidSpec("fix_invalid needs params.sentinels (non-empty)".into()));
    }

    let target_cols: Vec<String> = if let Some(serde_json::Value::Array(arr)) = params.get("columns") {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
    } else if let Some(column) = params.get("column").and_then(|v| v.as_str()) {
        vec![column.to_string()]
    } else {
        df.columns()
            .iter()
            .filter(|s| matches!(s.dtype(), DataType::String))
            .map(|s| s.name().to_string())
            .collect()
    };
    if target_cols.is_empty() {
        return Err(DataError::InvalidSpec("fix_invalid: no target string columns".into()));
    }
    let known: HashSet<String> = df.columns().iter().map(|c| c.name().to_string()).collect();
    for c in &target_cols {
        if !known.contains(c) {
            return Err(DataError::InvalidSpec(format!("fix_invalid: unknown column {c:?}")));
        }
    }

    let mut exprs: Vec<Expr> = Vec::with_capacity(target_cols.len());
    for cname in &target_cols {
        let mut cond: Option<Expr> = None;
        for s in &sentinels {
            let c = col(cname).cast(DataType::String).eq(lit(s.clone()));
            cond = Some(match cond {
                Some(prev) => prev.or(c),
                None => c,
            });
        }
        let cond = cond.unwrap();
        exprs.push(when(cond).then(replacement.clone()).otherwise(col(cname)).alias(cname));
    }
    df.lazy().with_columns(exprs).collect().map_err(DataError::from)
}
