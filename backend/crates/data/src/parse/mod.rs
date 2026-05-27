//! Byte buffer → Polars `DataFrame`.
//!
//! Single entry point for the upload pipeline: `from_csv_bytes` decodes
//! the raw upload (encoding sniff via `super::encoding`) and feeds the
//! resulting text through `parse_text`. The returned tuple is
//! `(DataFrame, encoding_name)` — the caller persists the encoding so it
//! can be surfaced in the cleaner sidebar.
//!
//! **`parse_text` does heuristic preamble + delimiter sniffing** before
//! handing off to Polars: real-world CSVs ride in with `""`, `# Export
//! …`, `Source: legacy v2`, or `sep=,` lines on top, which would
//! otherwise become the "header" and either cascade into ragged-rows
//! errors or yield a degenerate one-column parse. The scan looks at the
//! first 15 lines, tallies `, ; \t |` counts, and picks the
//! highest-count *(line, delimiter)* pair — preamble lines have ≤1 of
//! anything, the real header has many. Combined with Polars'
//! `truncate_ragged_lines`, this recovers 100% of the synthetic
//! `clean-score` stress dataset's raw files (was 18%).
//!
//! The redtable's page endpoint goes through `page()` — a LazyFrame
//! pipeline that chains filter → global search → sort → slice, then
//! projects the visible columns and stringifies cells.
//!
//! Targets polars 0.43 — `CsvReadOptions` + `into_reader_with_file_handle`.

use crate::{DataError, Result};
use polars::prelude::*;
use shared::file::{PageQuery, Row};

mod filter;
pub use filter::apply_filter;
use filter::{parse_filters, search_expr, tree_expr};

mod sniff;
pub use sniff::{parse_text_with_diag, RescueDiag};

/// Sniff Excel uploads by filename. Used by the upload route to dispatch
/// through `xlsx_to_csv` before the standard CSV pipeline kicks in.
/// Filename is the easier check than magic bytes — browsers preserve
/// extensions, and calamine auto-detects the underlying format
/// (xlsx is zip, xls is OLE-compound, xlsb is binary, ods is zip).
pub fn is_excel_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Strip a trailing upload extension from a filename, leaving the stem.
/// Mirrors the seven upload-accepted extensions (csv / tsv + the Excel
/// family + ods) — anything else passes through. Used by the upload /
/// snapshot / join handlers in routes/files.rs to persist
/// `project_files.filename` as a stem (mig 011), letting `file_type`
/// own the extension instead of duplicating it inside `filename`.
/// Borrows: returns a `&str` slice when stripped, the original `&str`
/// when no extension matched.
pub fn strip_upload_ext(name: &str) -> &str {
    const EXTS: &[&str] = &[".csv", ".tsv", ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"];
    let lower = name.to_ascii_lowercase();
    for ext in EXTS {
        if lower.ends_with(ext) {
            return &name[..name.len() - ext.len()];
        }
    }
    name
}

/// Convert an Excel workbook (xlsx / xls / xlsm / xlsb / ods) into a
/// UTF-8 CSV byte buffer. Reads the **first sheet** only — multi-sheet
/// workbooks lose their other tabs (same behaviour the Django app
/// applies). The output is fed back through `from_csv_bytes` so the
/// rest of the pipeline (encoding sniff, Polars CSV parser, dtype
/// inference, redtable paging) doesn't care that the user uploaded
/// xlsx.
///
/// Numbers without a fractional part are emitted as integers (no
/// scientific notation, no trailing `.0`) so dtype inference picks
/// Int64 where Excel stored a whole number. Dates use the ISO 8601
/// string form when calamine surfaces them as DateTimeIso /
/// DurationIso; cell-formatted dates that come back as floats are
/// left as floats (the user can apply a `format_dates` step).
pub fn xlsx_to_csv(bytes: &[u8]) -> Result<Vec<u8>> {
    use calamine::{open_workbook_auto_from_rs, Reader};

    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut wb = open_workbook_auto_from_rs(cursor)
        .map_err(|e| DataError::InvalidSpec(format!("excel: {e}")))?;

    let first = wb
        .sheet_names()
        .first()
        .ok_or_else(|| DataError::InvalidSpec("excel: workbook has no sheets".into()))?
        .clone();

    let range = wb
        .worksheet_range(&first)
        .map_err(|e| DataError::InvalidSpec(format!("excel sheet `{first}`: {e}")))?;

    let mut wtr = csv::Writer::from_writer(Vec::<u8>::new());
    for row in range.rows() {
        let cells: Vec<String> = row.iter().map(cell_to_string).collect();
        wtr.write_record(&cells)
            .map_err(|e| DataError::InvalidSpec(format!("csv encode: {e}")))?;
    }
    wtr.into_inner()
        .map_err(|e| DataError::InvalidSpec(format!("csv finalize: {e}")))
}

fn cell_to_string(v: &calamine::Data) -> String {
    use calamine::Data;
    match v {
        Data::Empty           => String::new(),
        Data::String(s)       => s.clone(),
        Data::Int(i)          => i.to_string(),
        Data::Float(f) => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Bool(b)         => if *b { "true".into() } else { "false".into() },
        Data::DateTime(dt)    => dt.to_string(),
        Data::DateTimeIso(s)  => s.clone(),
        Data::DurationIso(s)  => s.clone(),
        Data::Error(_)        => String::new(),
    }
}

/// Decode + parse a CSV upload, sniffing the encoding via chardetng.
///
/// `tld_hint` is forwarded to chardetng (e.g. `Some("fr")` for French
/// CSVs — disambiguates windows-1252 vs other single-byte codecs).
pub fn from_csv_bytes(bytes: &[u8], tld_hint: Option<&str>) -> Result<(DataFrame, String)> {
    let (df, enc, _diag) = from_csv_bytes_with_diag(bytes, tld_hint)?;
    Ok((df, enc))
}

/// Same as [`from_csv_bytes`] but also returns the wrapped-CSV rescue
/// outcome. Used by the wasm bench harness's `parse_csv` so the diag
/// surfaces alongside the parse stats — lets the table differentiate a
/// genuinely 1-col CSV from a wrapped file the rescue couldn't unwrap.
pub fn from_csv_bytes_with_diag(
    bytes:     &[u8],
    tld_hint:  Option<&str>,
) -> Result<(DataFrame, String, RescueDiag)> {
    let (text, encoding) = crate::encoding::decode(bytes, tld_hint);
    let (df, diag) = parse_text_with_diag(text)?;
    Ok((df, encoding, diag))
}

/// Decode + parse with a caller-specified encoding (the user's override
/// in the cleaning sidebar). Skips auto-detection entirely so mojibake
/// only comes back if the user picked the wrong codec.
pub fn from_csv_bytes_with_encoding(bytes: &[u8], encoding_label: &str) -> Result<DataFrame> {
    let enc = encoding_rs::Encoding::for_label(encoding_label.as_bytes())
        .ok_or_else(|| DataError::Encoding(format!("unknown encoding: {encoding_label}")))?;
    let (cow, _, _) = enc.decode(bytes);
    parse_text(cow.into_owned())
}

/// Thin wrapper that drops the rescue diag — every existing caller
/// (`from_csv_bytes`, `from_csv_bytes_with_encoding`, `steps::unwrap_csv`'s
/// re-parse) doesn't need it. The wasm bench's `parse_csv` calls
/// [`parse_text_with_diag`] directly through [`from_csv_bytes_with_diag`].
pub fn parse_text(text: String) -> Result<DataFrame> {
    parse_text_with_diag(text).map(|(df, _)| df)
}


/// Paginate a DataFrame for the redtable.
///
/// Pipeline order: filter (`filters` JSON spec) → global search (`q`) →
/// sort (`sort` + `dir`) → collect → slice (`page` + `size`) →
/// column projection (`cols`) → stringify.
pub fn page(df: &DataFrame, q: &PageQuery) -> Result<(Vec<Row>, u64, u64, Vec<u32>)> {
    let all_count = df.height() as u64;

    // A hidden row-index column rides along through filter/sort/slice so
    // we can hand back absolute indices for the frontend's select-mode.
    const IDX_COL: &str = "__rp_idx__";
    let mut lf = df.clone().lazy().with_row_index(IDX_COL, Some(0));

    // 1. Filters — accepts the tree form OR the legacy Vec<FilterSpec>.
    if let Some(json) = q.filters.as_deref().filter(|s| !s.is_empty()) {
        let node = parse_filters(json)?;
        if let Some(expr) = tree_expr(&node)? {
            lf = lf.filter(expr);
        }
    }

    // 2. Global search across string columns.
    if let Some(needle) = q.q.as_deref().filter(|s| !s.is_empty()) {
        if let Some(expr) = search_expr(needle, df) {
            lf = lf.filter(expr);
        }
    }

    // 3. Sort. Prefer the `sorts` multi-key JSON; fall back to the
    //    legacy single `sort`/`dir` pair. Unknown columns are silently
    //    dropped so a stale frontend can't 500 the request.
    let mut sort_keys: Vec<(String, bool)> = Vec::new();
    if let Some(json) = q.sorts.as_deref().filter(|s| !s.is_empty()) {
        #[derive(serde::Deserialize)]
        struct SortKey { col: String, #[serde(default)] dir: String }
        if let Ok(items) = serde_json::from_str::<Vec<SortKey>>(json) {
            for it in items {
                if !it.col.is_empty() && df.column(&it.col).is_ok() {
                    sort_keys.push((it.col, it.dir.eq_ignore_ascii_case("desc")));
                }
            }
        }
    }
    if sort_keys.is_empty() {
        if let Some(c) = q.sort.as_deref().filter(|s| !s.is_empty()) {
            if df.column(c).is_ok() {
                let desc = q.dir.as_deref().map(|d| d.eq_ignore_ascii_case("desc")).unwrap_or(false);
                sort_keys.push((c.to_string(), desc));
            }
        }
    }
    if !sort_keys.is_empty() {
        let by:          Vec<String> = sort_keys.iter().map(|(c, _)| c.clone()).collect();
        let descending:  Vec<bool>   = sort_keys.iter().map(|(_, d)| *d).collect();
        let opts = SortMultipleOptions::default().with_order_descending_multi(descending);
        lf = lf.sort(by, opts);
    }

    // 4. Collect — single materialisation, lets Polars optimize the chain.
    let view = lf.collect().map_err(DataError::from)?;

    // 5. Slice for the page.
    let total = view.height() as u64;
    let page  = q.page.unwrap_or(1).max(1);
    // "All rows" comes through as a large sentinel from the frontend;
    // 50k is the ceiling we trust the browser to render.
    let size  = q.size.unwrap_or(25).clamp(1, 50_000);
    let offset = ((page - 1) as i64).saturating_mul(size as i64);
    let slice = view.slice(offset, size as usize);

    // 6. Extract absolute row indices from the helper column, then drop it.
    let idx_col = slice.column(IDX_COL).map_err(DataError::from)?;
    let mut row_indices: Vec<u32> = Vec::with_capacity(slice.height());
    for r in 0..slice.height() {
        let v = idx_col.get(r).map_err(DataError::from)?;
        row_indices.push(match v {
            AnyValue::UInt32(n) => n,
            AnyValue::UInt64(n) => n as u32,
            AnyValue::Int64(n)  => n as u32,
            AnyValue::Int32(n)  => n as u32,
            _ => 0,
        });
    }

    // 7. Column projection. Either honour cols= (already excludes the
    //    helper col since the user can't name it) or drop the helper
    //    explicitly.
    let projected: DataFrame = if let Some(cols) = q.cols.as_deref().filter(|s| !s.is_empty()) {
        let names: Vec<&str> = cols.split(',').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        slice.select(names).map_err(DataError::from)?
    } else {
        let names: Vec<String> = slice.get_columns().iter()
            .map(|c| c.name().to_string())
            .filter(|n| n != IDX_COL)
            .collect();
        let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        slice.select(refs).map_err(DataError::from)?
    };

    // 8. Stringify cells in column order.
    let cols = projected.get_columns();
    let n = projected.height();
    let mut rows: Vec<Row> = Vec::with_capacity(n);
    for r in 0..n {
        let mut row: Row = Vec::with_capacity(cols.len());
        for c in cols {
            let val = c.get(r).map_err(DataError::from)?;
            row.push(stringify(&val));
        }
        rows.push(row);
    }

    Ok((rows, total, all_count, row_indices))
}

fn stringify(v: &AnyValue) -> Option<String> {
    match v {
        AnyValue::Null => None,
        AnyValue::String(s) => Some((*s).to_string()),
        AnyValue::StringOwned(s) => Some(s.to_string()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Default (case_sensitive omitted) — historical behavior, both
    /// "Paris" and "paris" match `contains: "par"`.
    #[test]
    fn filter_contains_default_is_case_insensitive() {
        let df = df!["city" => ["Paris", "PARIS", "Lyon", "paris"]].unwrap();
        let filter = serde_json::json!({
            "col": "city", "op": "contains", "value": "par"
        }).to_string();
        let out = apply_filter(df, &filter).unwrap();
        assert_eq!(out.height(), 3, "all three 'paris' variants match");
    }

    /// `case_sensitive: true` — only the literal case matches.
    #[test]
    fn filter_contains_case_sensitive_only_exact_case() {
        let df = df!["city" => ["Paris", "PARIS", "Lyon", "paris"]].unwrap();
        let filter = serde_json::json!({
            "col": "city", "op": "contains", "value": "Par",
            "case_sensitive": true
        }).to_string();
        let out = apply_filter(df, &filter).unwrap();
        assert_eq!(out.height(), 1, "only 'Paris' (capital P) matches");
        let cities: Vec<Option<&str>> =
            out.column("city").unwrap().str().unwrap().into_iter().collect();
        assert_eq!(cities, vec![Some("Paris")]);
    }

    /// `case_sensitive: false` explicit — same as default; locks the
    /// contract so a later "default to true" refactor would fail this
    /// test loudly.
    #[test]
    fn filter_eq_case_insensitive_when_flag_false() {
        let df = df!["name" => ["Alice", "ALICE", "Bob"]].unwrap();
        let filter = serde_json::json!({
            "col": "name", "op": "eq", "value": "alice",
            "case_sensitive": false
        }).to_string();
        let out = apply_filter(df, &filter).unwrap();
        assert_eq!(out.height(), 2, "both Alice + ALICE match lowercased 'alice'");
    }

    /// `case_sensitive: true` on the `in` set op — array membership
    /// honors casing too, not just single-value ops.
    #[test]
    fn filter_in_case_sensitive_array() {
        let df = df!["country" => ["FR", "fr", "BE", "be"]].unwrap();
        let filter = serde_json::json!({
            "col": "country", "op": "in", "value": ["FR", "BE"],
            "case_sensitive": true
        }).to_string();
        let out = apply_filter(df, &filter).unwrap();
        assert_eq!(out.height(), 2, "only uppercase FR + BE match");
        let countries: Vec<Option<&str>> =
            out.column("country").unwrap().str().unwrap().into_iter().collect();
        assert_eq!(countries, vec![Some("FR"), Some("BE")]);
    }
}
