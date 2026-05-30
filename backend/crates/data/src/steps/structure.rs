//! Doc: docs/internal/code/backend/data/steps/structure.md
//! Structure-changing cleaning steps: wrapped-CSV rescue,
//! concat two columns into one, split one column into many,
//! date column reformat (parse + restringify).
//!
//! These reshape the frame's columns (count or types) rather than
//! mutate cell values in place.

use std::collections::HashSet;

use crate::{DataError, Result};
use polars::prelude::*;

use super::util::{parse_date_flex, select_keep};

/// Rescue a "wrapped" CSV upload. When the source file was
/// double-quoted with internal quotes escaped, every row parses
/// as one string column. The fix: take that single column's
/// values, prepend the (likely) embedded header, feed the
/// result back through the CSV parser.
///
/// Refuses to operate on a DF with more than one column — at
/// that point the file is already unwrapped (probably from a
/// prior step) and re-parsing would silently corrupt it.
pub(super) fn unwrap_csv(df: DataFrame, _params: &serde_json::Value) -> Result<DataFrame> {
    if df.width() != 1 {
        return Err(DataError::InvalidSpec(
            "unwrap_csv only applies to a single-column DataFrame".into()));
    }
    let series = &df.get_columns()[0];

    // A "wrapped" CSV is one where the real record was quoted
    // whole, so Polars' first parse collapsed it to one column.
    //
    // The hard case (`raw_dossier_onecol_tricky`): the wrapping
    // is INCONSISTENT row by row — inner delimiter varies
    // (`,` `;` `|`), quote style varies (`"…"`, `\"…\"`, `'…'`,
    // bare), and some rows lost their outer wrap. A single
    // file-wide delimiter sniff (the old approach) left every
    // `;`/`|` row unsplit. Fix: parse each record on ITS OWN
    // sniffed delimiter + quote style, then re-emit one
    // canonical CSV for a typed re-parse.

    // Peel the OUTER wrapping Polars left — a balanced `"…"`
    // pair plus doubled-`""` unescaping.
    fn defensive_unquote(s: &str) -> String {
        let t = s.trim();
        let inner = if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
            &t[1..t.len() - 1]
        } else {
            t
        };
        inner.replace("\"\"", "\"")
    }

    // Most-frequent delimiter for THIS record — decided per row,
    // not once for the file.
    fn sniff_delim(record: &str) -> u8 {
        const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];
        DELIMS.iter()
            .map(|&d| (d, record.bytes().filter(|&b| b == d).count()))
            .filter(|&(_, n)| n > 0)
            .max_by_key(|&(_, n)| n)
            .map(|(d, _)| d)
            .unwrap_or(b',')
    }

    // Strip one balanced outer pair of `q` from a field value.
    fn strip_pair(s: &str, q: char) -> String {
        let t = s.trim();
        if t.chars().count() >= 2 && t.starts_with(q) && t.ends_with(q) {
            t[q.len_utf8()..t.len() - q.len_utf8()].to_string()
        } else {
            t.to_string()
        }
    }

    // Parse ONE record into fields. The wrapped corpus has
    // reliable delimiter structure but UNreliable quoting —
    // stray / unbalanced `"`, mixed `"` and `'`. Quote-aware
    // parsing trips on that junk and drops fields, so split on
    // the delimiter alone, then strip a balanced outer quote
    // pair (`"` or `'`) per field. `\"`-escaped quotes are
    // normalised to plain `"` first. (Trade-off: a field value
    // containing the delimiter would mis-split — acceptable for
    // a wrapped-file rescue, where structure beats the rare
    // delimiter-in-value.)
    fn unwrap_record(record: &str) -> Vec<String> {
        let rec = record.trim().replace("\\\"", "\"");
        if rec.is_empty() {
            return Vec::new();
        }
        let delim = sniff_delim(&rec) as char;
        rec.split(delim)
            .map(|f| {
                let unquoted = strip_pair(f.trim(), '"');
                strip_pair(&unquoted, '\'')
            })
            .collect()
    }

    // The wrapped header was line 0 of the source → the column
    // name. Unwrap it the same way to recover the real headers.
    let header = {
        let h = unwrap_record(&defensive_unquote(&series.name().to_string()));
        if h.is_empty() { vec!["column_1".to_string()] } else { h }
    };
    let width = header.len();

    let mut rows: Vec<Vec<String>> = Vec::with_capacity(series.len());
    for i in 0..series.len() {
        let raw = match series.get(i).map_err(DataError::from)? {
            AnyValue::Null            => continue,
            AnyValue::String(s)       => s.to_string(),
            AnyValue::StringOwned(s)  => s.to_string(),
            other                     => other.to_string(),
        };
        // A cell can hold MORE THAN ONE record. The first CSV
        // parse merges any line whose quotes don't balance,
        // swallowing the following line(s) into one field as
        // embedded newlines. Split them back into separate rows
        // — the "rows" half of the unwrap — then unwrap each.
        for line in raw.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            rows.push(unwrap_record(&defensive_unquote(line)));
        }
    }

    // Re-emit every record in one canonical CSV (comma, standard
    // quoting), conformed to the header width so the buffer is
    // rectangular for the typed re-parse via `parse_text`.
    let conform = |r: &[String]| -> Vec<String> {
        let mut out = r.to_vec();
        out.resize(width, String::new());
        out
    };
    let mut wtr = csv::WriterBuilder::new().from_writer(Vec::<u8>::new());
    wtr.write_record(&conform(&header))
        .map_err(|e| DataError::InvalidSpec(format!("unwrap csv encode: {e}")))?;
    for r in &rows {
        wtr.write_record(&conform(r))
            .map_err(|e| DataError::InvalidSpec(format!("unwrap csv encode: {e}")))?;
    }
    let buf = wtr.into_inner()
        .map_err(|e| DataError::InvalidSpec(format!("unwrap csv finalize: {e}")))?;
    let text = String::from_utf8(buf)
        .map_err(|e| DataError::InvalidSpec(format!("unwrap csv utf8: {e}")))?;

    crate::parse::parse_text(text)
}

pub(super) fn join_columns(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let col1 = params.get("col1").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("join_columns needs params.col1".into()))?;
    let col2 = params.get("col2").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("join_columns needs params.col2".into()))?;
    let sep  = params.get("sep").and_then(|v| v.as_str()).unwrap_or(" ").to_string();
    let new_name = params.get("new_name").and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("{col1}_{col2}"));

    let joined = concat_str(
        [col(col1).cast(DataType::String), col(col2).cast(DataType::String)],
        &sep,
        false,
    ).alias(new_name.as_str());

    // Add the new column, then keep everything but the two sources.
    let lf = df.lazy().with_columns([joined]).collect().map_err(DataError::from)?;
    let to_drop: HashSet<&str> = [col1, col2].into_iter().collect();
    let keep: Vec<String> = lf.get_columns().iter()
        .map(|c| c.name().to_string())
        .filter(|n| !to_drop.contains(n.as_str()))
        .collect();
    select_keep(lf, &keep)
}

/// Split `column` on `sep` into `column_1`, `column_2`, … —
/// up to MAX_PARTS new columns. `keep_original` defaults to
/// false (the source column is dropped after the split).
pub(super) fn split_column(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    const MAX_PARTS: usize = 10;
    let column = params.get("column").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("split_column needs params.column".into()))?;
    let sep = params.get("sep").and_then(|v| v.as_str()).unwrap_or(",").to_string();
    let keep_original = params.get("keep_original").and_then(|v| v.as_bool()).unwrap_or(false);

    // Pre-scan to find the max split count (caps at MAX_PARTS).
    let src = df.column(column).map_err(DataError::from)?;
    let mut max_parts = 1usize;
    for i in 0..src.len() {
        let v = src.get(i).map_err(DataError::from)?;
        let s = match v {
            AnyValue::Null            => continue,
            AnyValue::String(s)       => (*s).to_string(),
            AnyValue::StringOwned(s)  => s.to_string(),
            other                     => other.to_string(),
        };
        let parts = s.split(sep.as_str()).count();
        if parts > max_parts { max_parts = parts; }
        if max_parts >= MAX_PARTS { break; }
    }
    let n = max_parts.min(MAX_PARTS);

    // Build a list-typed split expression once, then peel
    // elements out via list().get(i).
    let split = col(column).str().split(lit(sep)).alias("__split_tmp__");

    let mut new_cols: Vec<Expr> = Vec::with_capacity(n);
    for i in 0..n {
        let part_name = format!("{column}_{}", i + 1);
        new_cols.push(
            split.clone().list().get(lit(i as i64), true).alias(part_name.as_str()),
        );
    }
    let lf = df.lazy().with_columns(new_cols).collect().map_err(DataError::from)?;
    if keep_original { Ok(lf) }
    else {
        let to_drop: HashSet<&str> = [column].into_iter().collect();
        let keep: Vec<String> = lf.get_columns().iter()
            .map(|c| c.name().to_string())
            .filter(|n| !to_drop.contains(n.as_str()))
            .collect();
        select_keep(lf, &keep)
    }
}

/// Parse `column` as a Date with flexible matching, then
/// restringify with `fmt` (default ISO).
///   on_incomplete = "null" → unparseable become null
///   on_incomplete = "drop" → row is filtered out
///   on_incomplete = "keep" → original value is preserved
pub(super) fn format_dates(df: DataFrame, params: &serde_json::Value) -> Result<DataFrame> {
    let column = params.get("column").and_then(|v| v.as_str())
        .ok_or_else(|| DataError::InvalidSpec("format_dates needs params.column".into()))?;
    let fmt = params.get("fmt").and_then(|v| v.as_str()).unwrap_or("%Y-%m-%d").to_string();
    let on_incomplete = params.get("on_incomplete").and_then(|v| v.as_str()).unwrap_or("null");

    // Multi-format parser — handles ISO, slash, dot, and dotted
    // European styles. See parse_date_flex below.
    let parsed = parse_date_flex(column);
    let formatted = parsed.clone().dt().strftime(fmt.as_str());

    let new_value = match on_incomplete {
        "null" | "drop" => formatted,
        "keep"          => formatted.fill_null(col(column).cast(DataType::String)),
        other => return Err(DataError::InvalidSpec(
            format!("unsupported on_incomplete: {other}"))),
    };
    let with_new = df.lazy().with_columns([new_value.alias(column)]);
    let result = if on_incomplete == "drop" {
        with_new.filter(col(column).is_not_null())
    } else {
        with_new
    };
    result.collect().map_err(DataError::from)
}
