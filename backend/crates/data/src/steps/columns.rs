//! Purpose: column-shape + name cleaning steps (drop / keep / rename /
//! snake_case / replace-in-names). Pure schema mutations — values untouched.

use std::collections::HashSet;

use polars::prelude::*;

use super::util::{arr_strings, select_keep, snake_case};
use crate::{DataError, Result};

pub(super) fn drop_columns(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let cols = arr_strings(params, "cols");
    if cols.is_empty() {
        return Err(DataError::InvalidSpec("drop_columns needs params.cols: [string]".into()));
    }
    let to_drop: HashSet<&str> = cols.iter().map(|s| s.as_str()).collect();
    let keep: Vec<String> = df
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .filter(|n| !to_drop.contains(n.as_str()))
        .collect();
    select_keep(df, &keep)
}

/// params.cols = names to KEEP, in order.
pub(super) fn filter_columns(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let cols = arr_strings(params, "cols");
    if cols.is_empty() {
        return Err(DataError::InvalidSpec("filter_columns needs params.cols: [string]".into()));
    }
    select_keep(df, &cols)
}

pub(super) fn rename_column(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let from = params
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("rename_column needs params.from".into()))?;
    let to = params
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("rename_column needs params.to".into()))?;
    df.lazy().rename([from], [to], true).collect().map_err(DataError::from)
}

pub(super) fn snake_case_columns(df: DataFrame, _params: &serde_json::Value) -> Result<DataFrame> {
    let pairs: Vec<(String, String)> = df
        .columns()
        .iter()
        .map(|c| {
            let old = c.name().to_string();
            let new = snake_case(&old);
            (old, new)
        })
        .filter(|(a, b)| a != b)
        .collect();
    if pairs.is_empty() {
        return Ok(df);
    }
    let olds: Vec<&str> = pairs.iter().map(|(a, _)| a.as_str()).collect();
    let news: Vec<&str> = pairs.iter().map(|(_, b)| b.as_str()).collect();
    df.lazy().rename(olds, news, true).collect().map_err(DataError::from)
}

pub(super) fn replace_in_names(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let find = params
        .get("find")
        .and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("replace_in_names needs params.find".into()))?;
    let replace = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
    let pairs: Vec<(String, String)> = df
        .columns()
        .iter()
        .map(|c| {
            let old = c.name().to_string();
            let new = old.replace(find, replace);
            (old, new)
        })
        .filter(|(a, b)| a != b)
        .collect();
    if pairs.is_empty() {
        return Ok(df);
    }
    let olds: Vec<&str> = pairs.iter().map(|(a, _)| a.as_str()).collect();
    let news: Vec<&str> = pairs.iter().map(|(_, b)| b.as_str()).collect();
    df.lazy().rename(olds, news, true).collect().map_err(DataError::from)
}
