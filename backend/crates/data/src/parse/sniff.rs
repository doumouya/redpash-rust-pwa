//! Purpose: preamble/delimiter sniffing + wrapped-CSV rescue. Ported faithfully
//! (the corpus knowledge is the moat) — newline normalization first (lone-CR
//! files lose every row otherwise), two-pass quote-aware delimiter sniff, and
//! the wrapped-CSV DIAGNOSE-don't-fix contract (RescueDiag names what parse
//! SAW, never what it DID — the user confirms unwrap_csv as an explicit step).

use polars::prelude::*;
use std::io::Cursor;

use crate::{DataError, Result};

/// What the sniff recognised — surfaced so the cleaner UI can offer the rescue
/// as a confirmable step. Single-return parse variants drop it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescueDiag {
    /// Normal multi-column CSV (or a legitimate 1-col file). No suggestion.
    NotAttempted,
    /// Wrapped shape detected. The returned frame is the SAFE 1-column
    /// line-literal preservation (every row survives); the user decides
    /// whether to apply `unwrap_csv`.
    WrapDetected { preview_width: Option<u32> },
}

const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];

pub fn parse_text_with_diag(text: String) -> Result<(DataFrame, RescueDiag)> {
    // Normalize line endings FIRST — a lone-CR (classic-Mac) file reads as one
    // line otherwise and every data row is silently lost.
    let text = normalize_newlines(text);

    // Two passes over the first 15 lines. Pass 1: the first line with >=2
    // UNQUOTED delimiters is the header (quote-aware count ignores delimiters
    // inside "..."). Pass 2 (only if pass 1 never committed): skip 1-col
    // preamble junk for a single-column data list.
    let lines: Vec<&str> = text.lines().take(15).collect();
    let (mut skip_rows, mut delimiter, mut found_multi) = (0usize, b',', false);

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.get(..4).map(|p| p.eq_ignore_ascii_case("sep=")).unwrap_or(false) {
            continue;
        }
        let (best_d, best_n) = DELIMS
            .iter()
            .map(|&d| (d, count_unquoted(line, d)))
            .max_by_key(|(_, n)| *n)
            .unwrap_or((b',', 0));
        if best_n < 2 {
            continue;
        }
        skip_rows = i;
        delimiter = best_d;
        found_multi = true;
        break;
    }

    if !found_multi {
        for (i, line) in lines.iter().enumerate() {
            if looks_like_preamble_1col(line) {
                continue;
            }
            skip_rows = i;
            break;
        }
    }

    // Wrapped one-column file: every line is a single "...delimiters-inside..."
    // blob (no unquoted delimiter). Parse LINE-LITERALLY so unbalanced quotes
    // can't drop rows; the user splits with unwrap_csv.
    if !found_multi {
        let sample: Vec<&str> = text.lines().skip(skip_rows).take(20).collect();
        let wrapped = sample.len() >= 2 && {
            let rich = sample
                .iter()
                .filter(|l| DELIMS.iter().any(|&d| l.bytes().filter(|&b| b == d).count() >= 2))
                .count();
            rich * 2 >= sample.len()
        };
        if wrapped {
            let mut rows = text.lines().skip(skip_rows);
            let header = rows.next().unwrap_or("column_1");
            let values: Vec<&str> = rows.collect();
            let wrapped_df = DataFrame::new_infer_height(vec![
                Series::new(header.into(), values.as_slice()).into_column(),
            ])
            .map_err(DataError::from)?;
            return Ok((wrapped_df, RescueDiag::WrapDetected { preview_width: None }));
        }
    }

    let cursor = Cursor::new(text.into_bytes());
    CsvReadOptions::default()
        .with_has_header(true)
        .with_skip_rows(skip_rows)
        .with_infer_schema_length(Some(1024))
        // Bad-dtype cells become null instead of rejecting the whole file.
        .with_ignore_errors(true)
        .with_parse_options(
            CsvParseOptions::default()
                .with_separator(delimiter)
                .with_truncate_ragged_lines(true),
        )
        .into_reader_with_file_handle(cursor)
        .finish()
        .map(|df| (df, RescueDiag::NotAttempted))
        .map_err(DataError::from)
}

/// All line endings → `\n`. Fast-path returns untouched when there's no `\r`.
fn normalize_newlines(text: String) -> String {
    if !text.as_bytes().contains(&b'\r') {
        return text;
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Count byte `d` outside `"..."` regions (two-state machine).
fn count_unquoted(line: &str, d: u8) -> usize {
    let (mut n, mut in_q) = (0usize, false);
    for b in line.bytes() {
        if b == b'"' {
            in_q = !in_q;
        } else if b == d && !in_q {
            n += 1;
        }
    }
    n
}

/// "This line is preamble noise, not a 1-column header." Conservative: real
/// 1-2 word column names pass through.
fn looks_like_preamble_1col(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "sep" || lower.starts_with("sep=") {
        return true;
    }
    if t.starts_with('"') && t.ends_with('"') {
        return true;
    }
    if t.contains(": ") && t.len() >= 10 {
        return true;
    }
    if t.len() > 30 && t.contains(' ') {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_newlines_handles_cr_variants() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd".into()), "a\nb\nc\nd");
        assert_eq!(normalize_newlines("plain".into()), "plain");
    }

    #[test]
    fn cr_only_file_keeps_its_rows() {
        let (df, _) = parse_text_with_diag("id,name\r1,Alice\r2,Bob\r3,Carl".into()).unwrap();
        assert_eq!(df.height(), 3);
        assert_eq!(df.width(), 2);
    }

    #[test]
    fn quoted_embedded_newline_stays_one_field() {
        let (df, _) = parse_text_with_diag("a,b\n1,\"x\ry\"\n2,z\n".into()).unwrap();
        assert_eq!(df.height(), 2);
        assert_eq!(df.width(), 2);
    }

    #[test]
    fn preamble_then_header_is_skipped() {
        let (df, diag) =
            parse_text_with_diag("# Export 2026\nsep=,\nid,name\n1,Alice\n2,Bob\n".into()).unwrap();
        assert_eq!(df.height(), 2);
        assert_eq!(df.width(), 2);
        assert_eq!(diag, RescueDiag::NotAttempted);
    }
}
