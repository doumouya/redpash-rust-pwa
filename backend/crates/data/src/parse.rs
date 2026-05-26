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
use shared::filter::{FilterGroup, FilterNode, FilterOp, FilterSpec, GroupOp};
use std::io::Cursor;

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

/// Wrapped-CSV rescue outcome — what the in-parse `unwrap_csv` branch
/// did with the input. Surfaced by the `*_with_diag` parse variants so
/// callers (bench harness, future diagnostic tools) can tell apart
/// "file was normal" from "rescue attempted + delivered" from "rescue
/// attempted + fell back". The single-return-tuple variants
/// (`parse_text`, `from_csv_bytes`) keep their existing signature and
/// drop the diag; only callers that explicitly want it use the
/// `_with_diag` form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescueDiag {
    /// Pass-1 sniff found a normal multi-column CSV (or a legitimate
    /// 1-col preamble file) — wrapped-detection never fired.
    NotAttempted,
    /// Wrapped shape was detected and `unwrap_csv` ran. `delivered_width`
    /// is the post-unwrap column count: > 1 means the rescue delivered
    /// (the returned DataFrame is the recovered N-col frame); == 1 means
    /// it fell back to the safe line-literal frame (the unwrap step
    /// errored or returned width = 1 — see parse.rs's `_ => Ok(wrapped_df)`
    /// arm).
    Attempted { delivered_width: u32 },
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

pub fn parse_text_with_diag(text: String) -> Result<(DataFrame, RescueDiag)> {
    // Heuristic header / delimiter sniff. Real-world CSVs ride in with
    // junk on top — `""` blank lines, `# Export …` comments,
    // `Source: legacy v2` metadata, `Domaine: clients` markers, an
    // Excel `sep=,` hint — and Polars otherwise latches onto line 0 as
    // the header, which then disagrees with the data rows below and
    // either errors out ("found more fields than defined in 'Schema'")
    // or gives back a degenerate one-column frame.
    //
    // Two passes over the first 15 lines:
    //
    // **Pass 1 — multi-column.** Skip obvious preamble (empty / `#…` /
    // `sep=…`), then take the *first* line with ≥2 unquoted delimiters
    // of any flavour. The delimiter is the one that line has the most
    // of. Quote-aware counting (state machine, ignores delimiters
    // inside `"…"`) keeps a single quoted field that happens to
    // contain commas from skewing the count. This survives noisy data
    // rows below — French-decimal `1662,33` cells may give some data
    // rows one extra comma, but only the *header line itself* drives
    // the skip count, so the noise downstream doesn't matter.
    //
    // **Pass 2 — single-column with preamble.** Only fires when pass 1
    // never committed (no line had ≥2 delimiters). Catches the
    // `clean_006`-style file: a `sep` / `# Export …` / `Source: legacy
    // v2` / `Rapport confidentiel …` preamble block followed by a
    // legitimate single-column data list (`appt_id` then `REN96584`,
    // `REN12345`, …). Walks the same 15 lines and takes the first that
    // doesn't look like preamble; falls back to `skip = 0` (Polars'
    // default — same as a genuine 1-col file with the header on line
    // 0) if everything is preamble.
    const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];
    let lines: Vec<&str> = text.lines().take(15).collect();
    let (mut skip_rows, mut delimiter, mut found_multi) = (0usize, b',', false);

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() { continue; }
        if trimmed.starts_with('#') { continue; }
        if trimmed.get(..4).map(|p| p.eq_ignore_ascii_case("sep=")).unwrap_or(false) {
            continue;
        }
        let (best_d, best_n) = DELIMS.iter()
            .map(|&d| (d, count_unquoted(line, d)))
            .max_by_key(|(_, n)| *n)
            .unwrap_or((b',', 0));
        if best_n < 2 { continue; }
        skip_rows = i;
        delimiter = best_d;
        found_multi = true;
        break;
    }

    if !found_multi {
        for (i, line) in lines.iter().enumerate() {
            if looks_like_preamble_1col(line) { continue; }
            skip_rows = i;
            break;
        }
    }

    // **Wrapped one-column file.** Some exports quote the WHOLE record,
    // so every line is a single `"…delimiters-inside…"` blob — Pass 1
    // sees no *unquoted* delimiter and it reads as one column. Polars'
    // CSV parser would then merge, or silently drop, any line whose
    // quotes don't balance (a stray `"`) — losing rows before the user
    // can touch them. When the shape is detected, parse LINE-LITERALLY:
    // one physical line = one cell, no quote processing, so every row
    // survives intact for the `unwrap_csv` cleaning step to split.
    if !found_multi {
        let sample: Vec<&str> = text.lines().skip(skip_rows).take(20).collect();
        let wrapped = sample.len() >= 2 && {
            const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];
            let rich = sample.iter().filter(|l| {
                DELIMS.iter().any(|&d| l.bytes().filter(|&b| b == d).count() >= 2)
            }).count();
            rich * 2 >= sample.len()
        };
        if wrapped {
            let mut rows = text.lines().skip(skip_rows);
            let header = rows.next().unwrap_or("column_1");
            let values: Vec<&str> = rows.collect();
            let wrapped_df = DataFrame::new(
                vec![Series::new(header.into(), values.as_slice())],
            )
            .map_err(DataError::from)?;

            // Bake the rescue into the parse algorithm — the wrapped
            // detection above identified the shape, the unwrap step
            // knows the recovery. Em 2026-05-26: "if the parser is not
            // always exact without unwrap column but he is when
            // associated to unwrap, that means it's not a parser
            // without unwrap algorithm." Try unwrap; on success, return
            // the recovered N-col frame. On failure (edge cases
            // unwrap_csv can't handle: pathological mixed quoting, a
            // 1-col file that COINCIDENTALLY tripped the heuristic but
            // is actually genuine 1-col data), fall back to the safe
            // line-literal frame we always returned. Strictly more
            // capable than the previous behavior; users can still pop
            // an explicit unwrap_csv step in the Cleaner if the
            // automatic recovery missed an edge case.
            return match crate::steps::apply(
                wrapped_df.clone(),
                "unwrap_csv",
                &serde_json::Value::Null,
            ) {
                Ok(unwrapped) if unwrapped.width() > 1 => {
                    let w = unwrapped.width() as u32;
                    Ok((unwrapped, RescueDiag::Attempted { delivered_width: w }))
                }
                // Err OR width = 1 — fall back to the safe line-literal
                // frame. delivered_width: 1 names the fall-back state so
                // the bench can distinguish "rescue tried and failed" from
                // "rescue not attempted" (NotAttempted).
                _ => Ok((wrapped_df, RescueDiag::Attempted { delivered_width: 1 })),
            };
        }
    }

    let cursor = Cursor::new(text.into_bytes());
    CsvReadOptions::default()
        .with_has_header(true)
        .with_skip_rows(skip_rows)
        .with_infer_schema_length(Some(1024))
        // Bad-dtype cells become null instead of bubbling an error up
        // the upload path. Keeps a typo in one cell from rejecting a
        // 200-row file.
        .with_ignore_errors(true)
        .with_parse_options(
            CsvParseOptions::default()
                .with_separator(delimiter)
                // Polars' targeted fix for the "more fields than
                // schema" error — the dominant failure mode on raw
                // exports with a ragged trailing column or an
                // injected EXTRA field.
                .with_truncate_ragged_lines(true),
        )
        .into_reader_with_file_handle(cursor)
        .finish()
        .map(|df| (df, RescueDiag::NotAttempted))
        .map_err(DataError::from)
}

/// Count occurrences of byte `d` outside of `"…"` quoted regions.
/// A simple two-state machine — `"` toggles the in-quotes flag,
/// occurrences are counted only when not in quotes. This keeps a
/// quoted field with embedded delimiters (`"Smith, John"`) from
/// inflating the header-line count.
fn count_unquoted(line: &str, d: u8) -> usize {
    let (mut n, mut in_q) = (0usize, false);
    for b in line.bytes() {
        if b == b'"' { in_q = !in_q; }
        else if b == d && !in_q { n += 1; }
    }
    n
}

/// Heuristic "this line is preamble noise, not the header of a
/// 1-column file." Catches the patterns generators (and humans) sprinkle
/// on top of single-column lists: empty / `#…` comments, an Excel
/// `sep=,` hint (or its bare `sep` residue), a fully-quoted junk line
/// (`""`), a `Key: value` metadata line (`Source: legacy v2`), or long
/// prose (`Rapport confidentiel - ne pas diffuser`). Conservative on
/// purpose — real 1- and 2-word column names (`appt_id`, `customer
/// name`) pass through. When *every* sampled line looks like preamble,
/// the caller falls back to `skip = 0`, which is the same as a genuine
/// 1-col file with the header on line 0.
fn looks_like_preamble_1col(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() { return true; }
    if t.starts_with('#') { return true; }
    let lower = t.to_ascii_lowercase();
    if lower == "sep" || lower.starts_with("sep=") { return true; }
    if t.starts_with('"') && t.ends_with('"') { return true; }
    if t.contains(": ") && t.len() >= 10 { return true; }
    if t.len() > 30 && t.contains(' ') { return true; }
    false
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
    let raw   = col(cname);

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
        if cs { v } else { v.to_lowercase() }
    };
    // Lexicographic-range RHS — same casing rule as `val_op` so the
    // Between string-pair fallback stays consistent with Gt/Lt.
    let val_range = |v: Option<&serde_json::Value>| -> String {
        let s = v.and_then(|x| x.as_str()).unwrap_or("").to_string();
        if cs { s } else { s.to_lowercase() }
    };
    let val_num = || -> Result<f64> {
        let v = f.value.as_ref().ok_or_else(|| DataError::InvalidSpec(
            format!("{:?} needs a numeric value on column {cname}", f.op)))?;
        match v {
            serde_json::Value::Number(n) => n.as_f64().ok_or_else(||
                DataError::InvalidSpec(format!("non-finite number on {cname}"))),
            serde_json::Value::String(s) => s.parse::<f64>().map_err(|_|
                DataError::InvalidSpec(format!("not numeric on {cname}: {s:?}"))),
            _ => Err(DataError::InvalidSpec(format!("unsupported value type on {cname}"))),
        }
    };
    let val_pair = || -> Result<(f64, f64)> {
        let v = f.value.as_ref().ok_or_else(|| DataError::InvalidSpec(
            format!("between needs [a, b] on column {cname}")))?;
        let arr = v.as_array().ok_or_else(|| DataError::InvalidSpec(
            format!("between needs an array on column {cname}")))?;
        if arr.len() != 2 {
            return Err(DataError::InvalidSpec(format!("between needs [a, b] (got {} items)", arr.len())));
        }
        let parse = |x: &serde_json::Value| match x {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        };
        Ok((
            parse(&arr[0]).ok_or_else(|| DataError::InvalidSpec("between[0] not numeric".into()))?,
            parse(&arr[1]).ok_or_else(|| DataError::InvalidSpec("between[1] not numeric".into()))?,
        ))
    };

    // `In` / `NotIn` array values — lowercased on the case-insensitive
    // path, verbatim on the case-sensitive path. Mirrors `val_op`'s
    // single-side casing decision.
    let val_arr_op = || -> Result<Vec<String>> {
        let arr = f.value.as_ref().and_then(|v| v.as_array()).ok_or_else(||
            DataError::InvalidSpec(format!("{op:?} on {cname} needs an array value", op = f.op)))?;
        Ok(arr.iter()
            .map(|v| {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other                        => other.to_string(),
                };
                if cs { s } else { s.to_lowercase() }
            })
            .collect())
    };

    let expr = match f.op {
        FilterOp::Eq          => str_col.clone().eq(lit(val_op())),
        FilterOp::Neq         => str_col.clone().neq(lit(val_op())),
        FilterOp::In => {
            let needles = val_arr_op()?;
            if needles.is_empty() {
                lit(false)  // empty set → nothing matches
            } else {
                needles.into_iter()
                    .map(|n| str_col.clone().eq(lit(n)))
                    .reduce(|a, b| a.or(b))
                    .unwrap()
            }
        }
        FilterOp::NotIn => {
            let needles = val_arr_op()?;
            if needles.is_empty() {
                lit(true)   // empty exclusion → everything matches
            } else {
                needles.into_iter()
                    .map(|n| str_col.clone().neq(lit(n)))
                    .reduce(|a, b| a.and(b))
                    .unwrap()
            }
        }
        FilterOp::Contains    => str_col.clone().str().contains_literal(lit(val_op())),
        FilterOp::NotContains => str_col.clone().str().contains_literal(lit(val_op())).not(),
        FilterOp::StartsWith  => str_col.clone().str().starts_with(lit(val_op())),
        FilterOp::EndsWith    => str_col.clone().str().ends_with(lit(val_op())),
        // Range ops: try numeric first; on parse failure, fall back to
        // lexicographic string comparison (works for ISO dates).
        FilterOp::Gt  => match val_num() { Ok(n) => raw.gt(lit(n)),     Err(_) => str_col.clone().gt(lit(val_op())) },
        FilterOp::Gte => match val_num() { Ok(n) => raw.gt_eq(lit(n)),  Err(_) => str_col.clone().gt_eq(lit(val_op())) },
        FilterOp::Lt  => match val_num() { Ok(n) => raw.lt(lit(n)),     Err(_) => str_col.clone().lt(lit(val_op())) },
        FilterOp::Lte => match val_num() { Ok(n) => raw.lt_eq(lit(n)),  Err(_) => str_col.clone().lt_eq(lit(val_op())) },
        FilterOp::Between => {
            if let Ok((a, b)) = val_pair() {
                raw.clone().gt_eq(lit(a)).and(raw.lt_eq(lit(b)))
            } else {
                // String-pair fallback for ISO-date ranges. Uses the
                // same casing rule as the single-value text ops above.
                let arr = f.value.as_ref().and_then(|v| v.as_array()).ok_or_else(||
                    DataError::InvalidSpec(format!("between needs [a, b] on column {cname}")))?;
                let a = val_range(arr.get(0));
                let b = val_range(arr.get(1));
                str_col.clone().gt_eq(lit(a)).and(str_col.clone().lt_eq(lit(b)))
            }
        }
        // Date ops: cast the column + value to Date. Bogus dates cast
        // to NULL and the comparison fails for every row — same loud-
        // fail behavior as the steps.rs engine path. Value side stays
        // verbatim (date strings are case-irrelevant; the casing flag
        // is meaningless here).
        FilterOp::Before => raw.clone().cast(DataType::Date)
                                .lt(lit(val_str()).cast(DataType::Date)),
        FilterOp::After  => raw.clone().cast(DataType::Date)
                                .gt(lit(val_str()).cast(DataType::Date)),
        FilterOp::IsNull      => raw.is_null(),
        FilterOp::NotNull     => raw.is_not_null(),
    };
    Ok(expr)
}

/// Apply a JSON filter spec to a DataFrame and return the filtered
/// view. Used by endpoints that need the user's current filter to
/// shape the data they operate on (e.g. joins detect/create).
/// Empty / null JSON returns the frame untouched.
pub fn apply_filter(df: DataFrame, filter_json: &str) -> Result<DataFrame> {
    let trimmed = filter_json.trim();
    if trimmed.is_empty() || trimmed == "null" { return Ok(df); }
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
fn parse_filters(json: &str) -> Result<FilterNode> {
    if let Ok(node) = serde_json::from_str::<FilterNode>(json) {
        return Ok(node);
    }
    let leaves: Vec<FilterSpec> = serde_json::from_str(json)
        .map_err(|e| DataError::InvalidSpec(format!("filters: {e}")))?;
    Ok(FilterNode::Group(FilterGroup {
        op: GroupOp::And,
        children: leaves.into_iter().map(FilterNode::Leaf).collect(),
    }))
}

/// Recursively turn a FilterNode into a Polars Expr.
/// `Ok(None)` means "no constraint" (e.g. empty AND group); the caller
/// then skips applying any filter rather than wasting an Expr.
fn tree_expr(node: &FilterNode) -> Result<Option<Expr>> {
    match node {
        FilterNode::Leaf(spec) => Ok(Some(filter_expr(spec)?)),
        FilterNode::Group(g)   => {
            // Empty groups: empty AND = TRUE (no-op), empty OR = FALSE.
            if g.children.is_empty() {
                return Ok(match g.op {
                    GroupOp::And => None,
                    GroupOp::Or  => Some(lit(false)),
                });
            }
            let mut acc: Option<Expr> = None;
            for child in &g.children {
                if let Some(ce) = tree_expr(child)? {
                    acc = Some(match (&acc, g.op) {
                        (None, _)             => ce,
                        (Some(a), GroupOp::And) => a.clone().and(ce),
                        (Some(a), GroupOp::Or)  => a.clone().or(ce),
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
fn search_expr(needle: &str, df: &DataFrame) -> Option<Expr> {
    let lit_needle = lit(needle.to_lowercase());
    let mut acc: Option<Expr> = None;
    for c in df.get_columns() {
        if !matches!(c.dtype(), DataType::String) { continue; }
        let name = c.name().to_string();
        let part = col(name.as_str())
            .str().to_lowercase()
            .str().contains_literal(lit_needle.clone())
            .fill_null(lit(false));
        acc = Some(match acc {
            None    => part,
            Some(a) => a.or(part),
        });
    }
    acc
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
