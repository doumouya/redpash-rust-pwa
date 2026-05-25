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

use crate::{clean, dtype, parse, stats, steps};
use polars::prelude::*;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Module init — runs once when the .wasm is instantiated. Installs the
/// panic hook so a Rust panic surfaces as a real `console.error` with
/// file + line + payload, instead of the bare `RuntimeError: unreachable
/// executed` the wasm trap mechanism produces by default. Without this,
/// every panic on wasm32 is opaque.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

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

/// Phase C — browser-side CSV parse + cleanness scoring.
///
/// Takes raw CSV bytes, sniffs encoding via chardetng, parses through
/// polars `CsvReader`, runs the same `dtype::summarize` + `stats::
/// cleanness_report` the server uses on `/api/demo/parse`. Returns a
/// `DemoResult`-shaped JSON object — the wire shape matches the
/// existing demo endpoint so the frontend can swap server-side parse
/// for in-browser parse without changing its data path.
///
/// Phase C deliverables (per roadmap §5):
///   1. Does it compile? — adding this wrapper answers that.
///   2. Size delta? — measured before/after `tools/build-wasm.sh`.
///   3. Parse-time delta vs server round-trip? — measured by the
///      bench harness in `tools/wasm-bench/` against the 3-shape
///      corpus (small / 10k × 20 / 431k × 5).
///
/// Timing is the caller's concern — `performance.now()` in JS brackets
/// the call. We don't take a `std::time::Instant` here since wasm32's
/// `Instant` has been historically flaky (depends on the runtime's
/// monotonic clock); JS-side measurement is canonical.
#[wasm_bindgen]
pub fn parse_csv(bytes: &[u8]) -> Result<String, JsValue> {
    let (df, encoding) = parse::from_csv_bytes(bytes, None)
        .map_err(|e| JsValue::from_str(&format!("parse: {e}")))?;
    let cols = dtype::summarize(&df)
        .map_err(|e| JsValue::from_str(&format!("summarize: {e}")))?;
    let score = stats::cleanness_report(&df, &cols, &[])
        .map(|r| r.score as f64)
        .unwrap_or(0.0);

    // Type drift — string columns that semantically are numbers / dates
    // / bools. Same yardstick the demo endpoint uses.
    let type_mismatches = cols
        .iter()
        .filter(|c| {
            c.dtype == "string"
                && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool")
        })
        .count();

    // Empty-cell fraction across the whole grid.
    let total_cells = df.width() * df.height();
    let empty_cells: usize = df.get_columns().iter().map(|s| s.null_count()).sum();
    let empty_pct = if total_cells > 0 {
        empty_cells as f64 / total_cells as f64 * 100.0
    } else {
        0.0
    };

    Ok(json!({
        "rows":            df.height(),
        "columns":         df.width(),
        "score":           score,
        "type_mismatches": type_mismatches,
        "empty_pct":       empty_pct,
        "encoding":        encoding,
    })
    .to_string())
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
