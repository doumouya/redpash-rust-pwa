//! Purpose: the wasm-bindgen boundary — thin JSON-string in/out wrappers over
//! the SAME engine functions the server calls. No Polars types and no per-DTO
//! glue cross the boundary; the marshaling layer is all there is, which is what
//! keeps the size measurement honest (the wasm binary's content == the server
//! engine's content).
//!
//! The frontend's method list is GENERATED from these `#[wasm_bindgen]` exports
//! (via wasm-bindgen's output), never a hand-maintained array — the
//! predecessor's 13-exports-vs-6-wired drift is designed out.

#![cfg(target_arch = "wasm32")]

use polars::prelude::DataFrame;
use shared::filter::FilterNode;
use shared::query::QuerySpec;
use wasm_bindgen::prelude::*;

/// Install the panic hook once at module init so a Rust panic surfaces in the
/// browser console with file+line+payload instead of a bare `unreachable`.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The quality report over a resident frame — `summarize` → `cleanness_report`
/// + sentinels. Shared by `parse_score` (which adds encoding + rescue from the
/// parse diag) and `Workbook::score` (resident df, no parse diag), so the score
/// payload is the SAME object on both paths.
fn score_json(df: &DataFrame) -> Result<serde_json::Value, JsError> {
    let cols = crate::dtype::summarize(df).map_err(|e| JsError::new(&e.to_string()))?;
    let report = crate::stats::cleanness_report(df, &cols, &[]);
    let sentinels = crate::stats::find_sentinels(df, &[]);
    Ok(serde_json::json!({
        "rows": df.height(),
        "cols": df.width(),
        "score": report.map(|r| r.score),
        "report": report.map(|r| serde_json::json!({
            "completeness": r.completeness,
            "type_consistency": r.type_consistency,
            "value_hygiene": r.value_hygiene,
            "row_uniqueness": r.row_uniqueness,
            "structural": r.structural,
        })),
        "columns": cols,
        "sentinels": sentinels,
    }))
}

/// Parse + score a CSV given as raw bytes, in the browser — the SAME engine
/// (`parse` → `dtype::summarize` → `stats::cleanness_report`) the server's
/// upload path runs, so the client-side quality report is byte-identical to
/// the server's. `bytes never leave the device` is a real property here.
/// Returns a JSON string with the score, every sub-component, the column
/// metadata, the detected sentinels, encoding, and the rescue diagnosis.
#[wasm_bindgen]
pub fn parse_score(bytes: &[u8], tld: Option<String>) -> Result<String, JsError> {
    let (df, diag, enc) = crate::parse::from_csv_bytes(bytes, tld.as_deref())
        .map_err(|e| JsError::new(&e.to_string()))?;
    let mut out = score_json(&df)?;
    // Augment the shared report with the parse-time diagnostics only the
    // upload front door knows (encoding + rescue).
    if let Some(obj) = out.as_object_mut() {
        obj.insert("encoding".into(), serde_json::json!(enc));
        obj.insert("rescue".into(), serde_json::json!(format!("{diag:?}")));
    }
    Ok(out.to_string())
}

/// The resident client-side data engine — a parsed CSV held in browser memory.
/// The SAME `data` crate the server links: `from_csv` runs the upload parse
/// path, `page`/`filter_page` reuse `view::page` + `filter::apply_filter`, and
/// `score` reuses the cleanness report. So a page, a filtered page, or a score
/// computed in the browser is byte-identical to the server's for the same
/// bytes — and the rows never leave the device.
///
/// The frontend method surface is GENERATED from these `#[wasm_bindgen]`
/// exports; the JS instance methods are the camelCase-free names below
/// (`from_csv`, `page`, `filter_page`, `view`, `score`, `sql`, `rows`, `cols`).
#[wasm_bindgen]
pub struct Workbook {
    df: DataFrame,
}

#[wasm_bindgen]
impl Workbook {
    /// Parse raw CSV bytes into a resident workbook via the same front door as
    /// `parse_score` (`parse::from_csv_bytes`, decode + sniff + read). `tld`
    /// is the encoding hint (e.g. "fr") for the locale-aware decode.
    #[wasm_bindgen(js_name = from_csv)]
    pub fn from_csv(bytes: &[u8], tld: Option<String>) -> Result<Workbook, JsError> {
        let (df, _diag, _enc) = crate::parse::from_csv_bytes(bytes, tld.as_deref())
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Workbook { df })
    }

    /// A `[offset, offset+limit)` window of the resident frame as the canonical
    /// page JSON `{ columns, rows, total }` — `total` is the FULL row count.
    pub fn page(&self, offset: usize, limit: usize) -> Result<String, JsError> {
        let p = crate::view::page(&self.df, offset, limit);
        Ok(p.to_json().to_string())
    }

    /// Apply a `FilterNode` (JSON wire shape) then window the result.
    /// `filter_json` is the canonical `{node:"group"|"pred", ...}` tree; an
    /// empty group is match-all. Returns `{ columns, rows, total }` where
    /// `total` is the FILTERED height (rows matching the filter), so the client
    /// shows "N of M-filtered". The whole tree compiles to one Expr and
    /// collects once — the lazy-collect-in-a-single-thread path the smoke test
    /// exercises to catch fork panics.
    pub fn filter_page(
        &self,
        filter_json: &str,
        offset: usize,
        limit: usize,
    ) -> Result<String, JsError> {
        let filter: FilterNode =
            serde_json::from_str(filter_json).map_err(|e| JsError::new(&e.to_string()))?;
        let filtered =
            crate::filter::apply_filter(&self.df, &filter).map_err(|e| JsError::new(&e.to_string()))?;
        let p = crate::view::page(&filtered, offset, limit);
        Ok(p.to_json().to_string())
    }

    /// The composable window. `query_json` is the canonical `QuerySpec`
    /// `{ filter?, search?, sort? }` (null/`{}` = the whole frame); pagination is
    /// the `offset`/`limit` args. Applies **(filter AND search) → sort → page** —
    /// the SAME order and the SAME shape the server's POST `/page` runs, so a
    /// browser-computed window is byte-identical to the server's for the same
    /// bytes. One method serves the whole à-la-carte family (bare, searched,
    /// filtered, sorted, or any combination). Returns `{ columns, rows, total }`
    /// where `total` is the post-(filter+search) height — sort never changes it.
    pub fn view(
        &self,
        query_json: Option<String>,
        offset: usize,
        limit: usize,
    ) -> Result<String, JsError> {
        let q: QuerySpec = match query_json.as_deref() {
            Some(j) => serde_json::from_str(j).map_err(|e| JsError::new(&e.to_string()))?,
            None => QuerySpec::default(),
        };
        // (filter AND search) → one predicate, skipped entirely when both empty.
        let filtered: Option<DataFrame> =
            match crate::search::effective_filter(&self.df, q.filter.as_ref(), q.search.as_deref()) {
                Some(f) => Some(
                    crate::filter::apply_filter(&self.df, &f)
                        .map_err(|e| JsError::new(&e.to_string()))?,
                ),
                None => None,
            };
        let base: &DataFrame = filtered.as_ref().unwrap_or(&self.df);
        // then sort (skip an empty key list).
        let sorted: Option<DataFrame> = if q.sort.is_empty() {
            None
        } else {
            Some(crate::sort::apply_sort(base, &q.sort).map_err(|e| JsError::new(&e.to_string()))?)
        };
        let out: &DataFrame = sorted.as_ref().unwrap_or(base);
        let p = crate::view::page(out, offset, limit);
        Ok(p.to_json().to_string())
    }

    /// The cleanness report over the resident frame — the same score payload
    /// `parse_score` returns (minus the parse-time encoding/rescue diag).
    pub fn score(&self) -> Result<String, JsError> {
        Ok(score_json(&self.df)?.to_string())
    }

    /// Run a read-only SQL query against the resident frame, exposed as table
    /// `t`. The SAME engine + read-only guard the server `/sql` runs
    /// (`crate::sql::run_sql`) — so a browser query is byte-identical to the
    /// server's for the same bytes, and the rows never leave the device.
    /// Returns the first page of the result `{ columns, rows, total }`; the
    /// result is capped at `ROW_CAP` (add a LIMIT to narrow). Multi-file joins
    /// (extra named tables) stay on the server.
    pub fn sql(&self, query: &str) -> Result<String, JsError> {
        let frame = crate::sql::run_sql(vec![("t".to_string(), self.df.clone())], query)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let p = crate::view::page(&frame, 0, 500);
        Ok(p.to_json().to_string())
    }

    /// Row count of the resident frame.
    pub fn rows(&self) -> usize {
        self.df.height()
    }

    /// Column count of the resident frame.
    pub fn cols(&self) -> usize {
        self.df.width()
    }
}
