//! Doc: docs/internal/code/backend/data/parse/sniff.md
//! Preamble / delimiter sniffing + wrapped-CSV rescue.
//!
//! Splits off the heuristic head of `parse_text_with_diag` (the two-pass
//! line scan, quote-aware delimiter count, wrapped-shape detection) and
//! the diagnostic-return contract (`RescueDiag`). The result of the
//! sniff is fed into Polars' `CsvReadOptions` to do the actual parse;
//! all of that lives here so `parse/mod.rs` can stay focused on the
//! upload-decode + pagination concerns.
//!
//! Public surface re-exported from `parse`:
//! - [`RescueDiag`] — what the sniff *saw*, never what it *did*.
//! - [`parse_text_with_diag`] — sniff + parse, surfaces the diag.
//!
//! Internal helpers (`count_unquoted`, `looks_like_preamble_1col`) stay
//! module-private — they are sniff implementation details, not surface.

use crate::{DataError, Result};
use polars::prelude::*;
use std::io::Cursor;

/// Wrapped-CSV classification — what `parse_text_with_diag` recognised
/// about the input's shape. Surfaced by the `*_with_diag` parse variants
/// so callers (bench harness, the Cleaner UI's "apply this fix?" banner,
/// future diagnostic tools) can present the diagnosis to the user and
/// let them decide whether to apply the rescue step. The single-return
/// variants (`parse_text`, `from_csv_bytes`) drop the diag.
///
/// **Em 2026-05-26 product call:** parse stays diagnostic. The user
/// confirms transforms; the parser does NOT silently apply `unwrap_csv`.
/// This enum names what parse SAW, not what parse DID. The previous
/// auto-apply behaviour (commit 5bad5a2) is reverted — see the
/// `WrapDetected` arm in `parse_text_with_diag`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescueDiag {
    /// Pass-1 sniff found a normal multi-column CSV (or a legitimate
    /// 1-col preamble file) — wrapped detection never fired. No
    /// rescue suggestion; the returned DataFrame IS the parse result.
    NotAttempted,
    /// Wrapped shape was detected. The returned DataFrame is the safe
    /// line-literal preservation (1 column, every physical line one
    /// cell, every row survives intact). The user / caller decides
    /// whether to apply `unwrap_csv` as an explicit step to recover the
    /// N-col frame — that step is exposed through the Cleaner's step
    /// palette + `step_preview` in the WASM engine. `preview_width` is
    /// reserved for a future optional preview-then-confirm shape; today
    /// it is always `None` (no auto-preview computed).
    WrapDetected { preview_width: Option<u32> },
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

            // Parse stops at classification. Em 2026-05-26: *"the goal
            // is not to solve all type of tricky csv in one click,
            // before cleaning in one click, the priority is to provide
            // enough data about the files, with accuracy. then ask to
            // user 'apply this fix?'"* Reverts the auto-apply baked in
            // by commit 5bad5a2 — the rescue step is surfaced as a
            // *suggested* transform via `RescueDiag::WrapDetected`, but
            // the returned DataFrame is the safe 1-col line-literal
            // preservation. The user (or the FE Cleaner banner / the
            // wasm-bench's "apply" chip) decides whether to run the
            // explicit `unwrap_csv` step via `steps::apply` /
            // `step_preview`. Same machinery that handles every other
            // user-confirmed transform in the cleaning pipeline; parse
            // stops being the exception.
            return Ok((wrapped_df, RescueDiag::WrapDetected { preview_width: None }));
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
