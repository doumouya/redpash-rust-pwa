//! `data::wasm` — wasm-bindgen wrappers for the cheap data-engine
//! entry points.
//!
//! Compiled only for wasm32; the `api` crate depends on `data` as an
//! rlib and never sees this module. The wrappers are a thin marshaling
//! layer over JSON in / JSON out — they call the same engine functions
//! the server calls (`steps::apply`, `clean::auto_clean`), so the wasm
//! binary's content == the server engine's content. That's what makes
//! the Phase B size measurement honest.
//!
//! See docs/internal/roadmap-webassembly.md §5 Phase B.

use crate::{clean, steps};
use polars::prelude::*;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// JSON array of row objects → DataFrame.
///
/// Column type is inferred from the first non-null value per column:
/// f64 if numeric, bool if bool, otherwise String. Sufficient for the
/// page-preview use case where the rows already came from a typed
/// source (the server `/api/files/:rid/page` response) — no need for
/// the full Polars JSON reader here.
fn rows_to_df(rows_json: &str) -> Result<DataFrame, String> {
    let rows: Vec<serde_json::Map<String, Value>> = serde_json::from_str(rows_json)
        .map_err(|e| format!("rows parse: {e}"))?;
    if rows.is_empty() {
        return Ok(DataFrame::empty());
    }
    let columns: Vec<String> = rows[0].keys().cloned().collect();

    let mut series_list: Vec<Series> = Vec::with_capacity(columns.len());
    for col in &columns {
        // Type inference from first non-null value across all rows.
        let kind: &str = rows.iter().find_map(|r| match r.get(col) {
            Some(Value::Number(_)) => Some("number"),
            Some(Value::Bool(_))   => Some("bool"),
            Some(Value::String(_)) => Some("string"),
            _                      => None,
        }).unwrap_or("string");

        let s = match kind {
            "number" => {
                let v: Vec<Option<f64>> = rows.iter().map(|r| {
                    r.get(col).and_then(|v| {
                        v.as_f64().or_else(|| v.as_i64().map(|n| n as f64))
                    })
                }).collect();
                Series::new(col.as_str().into(), v)
            }
            "bool" => {
                let v: Vec<Option<bool>> = rows.iter()
                    .map(|r| r.get(col).and_then(|v| v.as_bool()))
                    .collect();
                Series::new(col.as_str().into(), v)
            }
            _ => {
                let v: Vec<Option<String>> = rows.iter().map(|r| {
                    r.get(col).and_then(|v| match v {
                        Value::Null      => None,
                        Value::String(s) => Some(s.clone()),
                        other            => Some(other.to_string()),
                    })
                }).collect();
                Series::new(col.as_str().into(), v)
            }
        };
        series_list.push(s);
    }
    DataFrame::new(series_list).map_err(|e| format!("df build: {e}"))
}

/// DataFrame → JSON array of row objects.
fn df_to_rows(df: &DataFrame) -> Result<String, String> {
    let n = df.height();
    let cols: Vec<&Series> = df.get_columns().iter().collect();
    let mut rows: Vec<Value> = Vec::with_capacity(n);
    for i in 0..n {
        let mut row = serde_json::Map::with_capacity(cols.len());
        for c in &cols {
            let v: Value = match c.get(i).unwrap_or(AnyValue::Null) {
                AnyValue::Null            => Value::Null,
                AnyValue::Boolean(b)      => Value::Bool(b),
                AnyValue::Int8(n)         => json!(n),
                AnyValue::Int16(n)        => json!(n),
                AnyValue::Int32(n)        => json!(n),
                AnyValue::Int64(n)        => json!(n),
                AnyValue::UInt8(n)        => json!(n),
                AnyValue::UInt16(n)       => json!(n),
                AnyValue::UInt32(n)       => json!(n),
                AnyValue::UInt64(n)       => json!(n),
                AnyValue::Float32(n)      => json!(n),
                AnyValue::Float64(n)      => json!(n),
                AnyValue::String(s)       => Value::String(s.into()),
                AnyValue::StringOwned(s)  => Value::String(s.to_string()),
                other                     => Value::String(other.to_string()),
            };
            row.insert(c.name().to_string(), v);
        }
        rows.push(Value::Object(row));
    }
    serde_json::to_string(&rows).map_err(|e| format!("rows serialize: {e}"))
}

/// Apply a `filter_rows` step over a JSON row set. `params_json` must
/// match the engine shape: `{combinator: "and"|"or", predicates: [{column, op, value?, case_sensitive?}, ...]}`.
#[wasm_bindgen]
pub fn apply_filter(rows_json: &str, params_json: &str) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let params: Value = serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&format!("params parse: {e}")))?;
    let out = steps::apply(df, "filter_rows", &params)
        .map_err(|e| JsValue::from_str(&format!("filter_rows: {e}")))?;
    df_to_rows(&out).map_err(|e| JsValue::from_str(&e))
}

/// Sort a JSON row set by one column. Multi-key sort can stack
/// calls or extend the wrapper later.
#[wasm_bindgen]
pub fn apply_sort(rows_json: &str, by: &str, descending: bool) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let out = df
        .sort([by], SortMultipleOptions::new().with_order_descending(descending))
        .map_err(|e| JsValue::from_str(&format!("sort: {e}")))?;
    df_to_rows(&out).map_err(|e| JsValue::from_str(&e))
}

/// Run `clean::auto_clean` over the rows; return both the cleaned rows
/// and the `CleanSummary` (junk-blanked / trimmed / duplicates) so the
/// browser can preview the diff before committing.
#[wasm_bindgen]
pub fn auto_clean(rows_json: &str) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let (cleaned, summary) = clean::auto_clean(&df)
        .map_err(|e| JsValue::from_str(&format!("auto_clean: {e}")))?;
    let rows_str = df_to_rows(&cleaned).map_err(|e| JsValue::from_str(&e))?;
    let rows_value: Value = serde_json::from_str(&rows_str)
        .map_err(|e| JsValue::from_str(&format!("rows reparse: {e}")))?;
    let summary_value = serde_json::to_value(&summary)
        .map_err(|e| JsValue::from_str(&format!("summary serialize: {e}")))?;
    Ok(json!({ "rows": rows_value, "summary": summary_value }).to_string())
}

/// Generic step preview — dispatch any `steps::apply` kind. The full
/// 17-step palette becomes browser-callable; later phases keep this
/// surface stable while replacing implementations.
#[wasm_bindgen]
pub fn step_preview(rows_json: &str, kind: &str, params_json: &str) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let params: Value = serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&format!("params parse: {e}")))?;
    let out = steps::apply(df, kind, &params)
        .map_err(|e| JsValue::from_str(&format!("step {kind}: {e}")))?;
    df_to_rows(&out).map_err(|e| JsValue::from_str(&e))
}
