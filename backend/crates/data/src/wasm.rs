//! Doc: docs/internal/code/backend/data/wasm.md
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

    let mut series_list: Vec<Column> = Vec::with_capacity(columns.len());
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
        series_list.push(s.into_column());
    }
    DataFrame::new_infer_height(series_list).map_err(|e| format!("df build: {e}"))
}

/// DataFrame → JSON array of row objects.
fn df_to_rows(df: &DataFrame) -> Result<String, String> {
    let n = df.height();
    let cols: Vec<&Column> = df.columns().iter().collect();
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
    let (df, encoding, rescue) = parse::from_csv_bytes_with_diag(bytes, None)
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
    let empty_cells: usize = df.columns().iter().map(|s| s.null_count()).sum();
    let empty_pct = if total_cells > 0 {
        empty_cells as f64 / total_cells as f64 * 100.0
    } else {
        0.0
    };

    // Wrapped-CSV classification — `wrap_detected` is true when the
    // parser's pass-1 sniff identified a wrapped shape AND held the
    // returned DataFrame as the safe 1-col line-literal preservation.
    // `suggested_step` names the explicit cleaning step the user (or
    // the Cleaner UI's "apply this fix?" banner) can run to recover
    // the N-col frame. Per Em 2026-05-26's product call, parse stays
    // diagnostic — the user confirms transforms; the parser does NOT
    // silently auto-apply.
    //
    // Bench / FE consumers: when `wrap_detected` is true and the user
    // wants the recovered frame, call `step_preview(rows, "unwrap_csv",
    // null)` against the 1-col DF — same step the Cleaner exposes.
    // `rescue_reason` names WHY the rescue surface did or didn't fire,
    // in our terms — closes the "outside reader infers wrong intent
    // from a thin wire field" gap that surfaced when Gemini was shown
    // an ultimate-tricky.csv bench result with zero codebase context
    // and confidently misread `wrap_detected: false` as "parser didn't
    // fail hard enough to need rescue" (Torv 22.04 Woz.md 06:45). Two
    // named reasons today; the enum is extensible if we add more
    // detection paths (encoding-confused, ragged-only, etc).
    let (wrap_detected, suggested_step, rescue_reason) = match rescue {
        parse::RescueDiag::NotAttempted => (
            false,
            Value::Null,
            "no_whole_file_wrap_signature",
        ),
        parse::RescueDiag::WrapDetected { preview_width: _ } => (
            true,
            json!("unwrap_csv"),
            "whole_file_wrap_detected",
        ),
    };

    Ok(json!({
        "rows":            df.height(),
        "columns":         df.width(),
        "score":           score,
        "type_mismatches": type_mismatches,
        "empty_pct":       empty_pct,
        "encoding":        encoding,
        "wrap_detected":   wrap_detected,
        "suggested_step":  suggested_step,
        "rescue_reason":   rescue_reason,
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

/// Helper: compute the same metric tuple `parse_csv` reports — rows /
/// columns / score / type_mismatches / empty_pct — for an arbitrary
/// DataFrame. Reused for both the raw and corrected legs of
/// `parse_csv_compare`. Keeps the metric definitions in one place so
/// the two reported sets share a single semantics.
fn df_metrics(df: &polars::prelude::DataFrame) -> (usize, usize, f64, usize, f64) {
    let cols = dtype::summarize(df).unwrap_or_default();
    let score = stats::cleanness_report(df, &cols, &[])
        .map(|r| r.score as f64)
        .unwrap_or(0.0);
    let type_mismatches = cols
        .iter()
        .filter(|c| {
            c.dtype == "string"
                && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool")
        })
        .count();
    let total_cells = df.width() * df.height();
    let empty_cells: usize = df.columns().iter().map(|s| s.null_count()).sum();
    let empty_pct = if total_cells > 0 {
        empty_cells as f64 / total_cells as f64 * 100.0
    } else {
        0.0
    };
    (df.height(), df.width(), score, type_mismatches, empty_pct)
}

/// Comparison parse — runs the parse pipeline twice's worth of work in
/// one wasm boundary crossing: once with the diagnostic-only output
/// (what production `parse_csv` returns; the user-confirms-transforms
/// model per Em 2026-05-26's product call), and once with the suggested
/// `unwrap_csv` step automatically applied (what the user would see
/// after clicking "apply this fix?" in the Cleaner UI).
///
/// The bench page (`frontend/wasm-bench.html`) renders both metric sets
/// side-by-side as two rows per iter — testing users see the trade-off
/// directly: raw = "what the parser hands the user when it detects a
/// wrap-shape it won't silently transform"; corrected = "what the user
/// gets after confirming the suggested step." When `wrap_detected` is
/// false there's nothing to apply; `corrected` equals `raw` and the
/// bench can collapse the rows visually.
///
/// JSON shape:
/// ```json
/// {
///   "raw":            { rows, columns, score, type_mismatches, empty_pct },
///   "corrected":      { rows, columns, score, type_mismatches, empty_pct },
///   "encoding":       "utf-8" | "windows-1252" | ...,
///   "wrap_detected":  bool,
///   "suggested_step": "unwrap_csv" | null,
///   "rescue_reason":  "no_whole_file_wrap_signature" | "whole_file_wrap_detected"
/// }
/// ```
#[wasm_bindgen]
pub fn parse_csv_compare(bytes: &[u8]) -> Result<String, JsValue> {
    let (df_raw, encoding, rescue) = parse::from_csv_bytes_with_diag(bytes, None)
        .map_err(|e| JsValue::from_str(&format!("parse: {e}")))?;

    let (raw_rows, raw_cols, raw_score, raw_tm, raw_empty) = df_metrics(&df_raw);

    let (wrap_detected, suggested_step, rescue_reason) = match rescue {
        parse::RescueDiag::NotAttempted => (
            false,
            Value::Null,
            "no_whole_file_wrap_signature",
        ),
        parse::RescueDiag::WrapDetected { preview_width: _ } => (
            true,
            json!("unwrap_csv"),
            "whole_file_wrap_detected",
        ),
    };

    // Corrected leg — apply `unwrap_csv` when a wrap was detected.
    // Falls back to the raw frame if the step errors (defensive: same
    // shape as parse.rs's pre-d1ea8df bake-in fallback). When no wrap
    // was detected, there's nothing to apply — corrected == raw.
    let (cor_rows, cor_cols, cor_score, cor_tm, cor_empty) = if wrap_detected {
        match steps::apply(df_raw.clone(), "unwrap_csv", &Value::Null) {
            Ok(df_cor) => df_metrics(&df_cor),
            Err(_) => (raw_rows, raw_cols, raw_score, raw_tm, raw_empty),
        }
    } else {
        (raw_rows, raw_cols, raw_score, raw_tm, raw_empty)
    };

    Ok(json!({
        "raw": {
            "rows":            raw_rows,
            "columns":         raw_cols,
            "score":           raw_score,
            "type_mismatches": raw_tm,
            "empty_pct":       raw_empty,
        },
        "corrected": {
            "rows":            cor_rows,
            "columns":         cor_cols,
            "score":           cor_score,
            "type_mismatches": cor_tm,
            "empty_pct":       cor_empty,
        },
        "encoding":        encoding,
        "wrap_detected":   wrap_detected,
        "suggested_step":  suggested_step,
        "rescue_reason":   rescue_reason,
    })
    .to_string())
}

// ─────────────────────────────────────────────────────────────────────
// Engine-completion exports — every remaining data-crate analysis op the
// server calls directly, now browser-callable over the same JSON-in /
// JSON-out shim ("everything that could be wasm is wasm": bring the
// compute to the data — zero-trust governance, no server round-trip).
// Each calls the IDENTICAL engine fn the api uses, so server and edge
// stay the same engine byte-for-byte.
// ─────────────────────────────────────────────────────────────────────

/// Group-by + aggregation (Reports). `spec_json` deserializes to a
/// `shared::report::ReportSpec` (group cols + aggregations + optional
/// filter / sort / top_n / windows); returns the aggregated frame as JSON
/// rows — the shape the server's report endpoint emits.
#[wasm_bindgen]
pub fn apply_group_by(rows_json: &str, spec_json: &str) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let spec: shared::report::ReportSpec = serde_json::from_str(spec_json)
        .map_err(|e| JsValue::from_str(&format!("spec parse: {e}")))?;
    let out = crate::group_by::execute(&df, &spec)
        .map_err(|e| JsValue::from_str(&format!("group_by: {e}")))?;
    df_to_rows(&out).map_err(|e| JsValue::from_str(&e))
}

/// Duplicate detection over the `by` key columns; returns a `DedupReport`
/// (duplicate groups + counts), example rows capped at `max_rows`.
#[wasm_bindgen]
pub fn dedup_detect(rows_json: &str, by_json: &str, max_rows: usize) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let by: Vec<String> = serde_json::from_str(by_json)
        .map_err(|e| JsValue::from_str(&format!("by parse: {e}")))?;
    let report = crate::dedup::detect(&df, &by, max_rows)
        .map_err(|e| JsValue::from_str(&format!("dedup_detect: {e}")))?;
    serde_json::to_string(&report).map_err(|e| JsValue::from_str(&format!("report serialize: {e}")))
}

/// Distinct values for one column with an optional case-insensitive
/// substring filter (`q`; empty = no filter), capped at `limit`. Powers
/// the filter-panel value autocomplete with no server call.
#[wasm_bindgen]
pub fn get_distinct_values(rows_json: &str, col: &str, q: &str, limit: usize) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let needle = if q.is_empty() { None } else { Some(q) };
    let result = crate::distinct::for_column(&df, col, needle, limit)
        .map_err(|e| JsValue::from_str(&format!("distinct: {e}")))?;
    let output = json!({
        "values": result.values,
        "total": result.total,
        "truncated": result.truncated,
    });
    Ok(output.to_string())
}

/// Join-candidate detection between two row sets: overlap-scores every
/// column pair, returns the `JoinCandidate`s scoring above `threshold`
/// (0.0–1.0), capped at `max_results`.
#[wasm_bindgen]
pub fn detect_join_candidates(
    this_rows_json: &str,
    other_rows_json: &str,
    threshold: f32,
    max_results: usize,
) -> Result<String, JsValue> {
    let this_df = rows_to_df(this_rows_json).map_err(|e| JsValue::from_str(&e))?;
    let other_df = rows_to_df(other_rows_json).map_err(|e| JsValue::from_str(&e))?;
    let candidates = crate::joins::detect_pair(&this_df, &other_df, threshold, max_results)
        .map_err(|e| JsValue::from_str(&format!("detect_pair: {e}")))?;
    let candidates = serde_json::to_value(&candidates)
        .map_err(|e| JsValue::from_str(&format!("candidates serialize: {e}")))?;
    Ok(json!({ "candidates": candidates }).to_string())
}

/// Sentinel-value scan — repeated placeholder / junk values (plus any
/// caller-supplied `extras`) across the grid, with per-column counts.
#[wasm_bindgen]
pub fn find_sentinels(rows_json: &str, extras_json: &str) -> Result<String, JsValue> {
    let df = rows_to_df(rows_json).map_err(|e| JsValue::from_str(&e))?;
    let extras: Vec<String> = serde_json::from_str(extras_json)
        .map_err(|e| JsValue::from_str(&format!("extras parse: {e}")))?;
    let items = stats::find_sentinels(&df, &extras);
    serde_json::to_string(&items).map_err(|e| JsValue::from_str(&format!("sentinels serialize: {e}")))
}

/// Structure diagnostics (line-ending / binary / delimiter / ragged /
/// header / type-drift suspicions). Takes the RAW CSV bytes — the
/// byte-level checks need the original bytes, not parsed rows — parses
/// them through the same engine, then runs `structure::detect(raw, &df)`.
#[wasm_bindgen]
pub fn detect_structure(bytes: &[u8]) -> Result<String, JsValue> {
    let (df, _encoding, _rescue) = parse::from_csv_bytes_with_diag(bytes, None)
        .map_err(|e| JsValue::from_str(&format!("parse: {e}")))?;
    let flags = crate::structure::detect(bytes, &df);
    serde_json::to_string(&flags).map_err(|e| JsValue::from_str(&format!("structure serialize: {e}")))
}

/// Read-only SQL over named JSON row tables — the SheetWise console, client-side
/// (SQL-redtable Phase 5). `tables_json` is an object `{ "name": [ {col: val, …}, … ], … }`
/// mapping each table alias to its rows; `sql` is the query. The read-only allowlist
/// (SELECT / WITH / set-ops; DDL/DML rejected) and the 500k-row result cap are enforced
/// INSIDE `crate::sql::run_sql` — the IDENTICAL engine fn the server's `/api/files/:rid/sql`
/// calls — so the browser and server run one SQL substrate, and bytes never leave the device.
#[wasm_bindgen]
pub fn run_sql(tables_json: &str, sql: &str) -> Result<String, JsValue> {
    let map: serde_json::Map<String, Value> = serde_json::from_str(tables_json)
        .map_err(|e| JsValue::from_str(&format!("tables parse: {e}")))?;
    let mut tables = Vec::with_capacity(map.len());
    for (name, rows) in map {
        let df = rows_to_df(&rows.to_string())
            .map_err(|e| JsValue::from_str(&format!("table '{name}': {e}")))?;
        tables.push((name, df));
    }
    let out =
        crate::sql::run_sql(tables, sql).map_err(|e| JsValue::from_str(&format!("sql: {e}")))?;
    df_to_rows(&out).map_err(|e| JsValue::from_str(&e))
}
