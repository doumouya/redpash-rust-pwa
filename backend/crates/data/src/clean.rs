//! Doc: docs/internal/code/backend/data/clean.md
//! Auto-clean — the conservative, always-safe transforms RedPash can
//! apply to a CSV with no human in the loop. Powers the landing-page
//! demo's "drop it → get it back clean" path.
//!
//! Deliberately narrow: only fixes that never lose real data and never
//! make a judgment call —
//!   1. trim leading / trailing whitespace from string cells;
//!   2. blank obvious junk placeholders (the canonical `SENTINELS`) and
//!      whitespace-only cells to a real null;
//!   3. drop fully-identical duplicate rows.
//!
//! The risky 10% — which rows to drop on a key, which columns to cast,
//! ambiguous date formats — stays the interactive cleaner's job.

use polars::prelude::*;
use serde::Serialize;

use crate::{stats::SENTINELS, Result};

/// What `auto_clean` changed — surfaced so the demo can say exactly
/// what was done to the file.
#[derive(Debug, Default, Clone, Serialize)]
pub struct CleanSummary {
    /// String cells that had surrounding whitespace stripped.
    pub cells_trimmed: usize,
    /// Junk-placeholder / whitespace-only cells turned into a real null.
    pub junk_blanked: usize,
    /// Fully-identical duplicate rows removed.
    pub duplicate_rows_dropped: usize,
}

impl CleanSummary {
    /// Did auto-clean actually change anything?
    pub fn is_noop(&self) -> bool {
        self.cells_trimmed == 0 && self.junk_blanked == 0 && self.duplicate_rows_dropped == 0
    }
}

/// Is `value` (already trimmed) a junk placeholder safe to blank?
fn is_junk(value: &str) -> bool {
    value.is_empty() || SENTINELS.iter().any(|s| s.eq_ignore_ascii_case(value))
}

/// Apply the always-safe auto-clean transforms. Returns the cleaned
/// frame and a summary of what changed.
pub fn auto_clean(df: &DataFrame) -> Result<(DataFrame, CleanSummary)> {
    let mut summary = CleanSummary::default();

    // ── 1 + 2. Per string column: trim, then blank junk to null. ─────
    let mut columns: Vec<Series> = Vec::with_capacity(df.width());
    for series in df.get_columns() {
        if series.dtype() != &DataType::String {
            columns.push(series.clone());
            continue;
        }
        let chunked = series.str()?;
        let mut cleaned: Vec<Option<&str>> = Vec::with_capacity(chunked.len());
        for cell in chunked.into_iter() {
            match cell {
                None => cleaned.push(None),
                Some(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.len() != raw.len() {
                        summary.cells_trimmed += 1;
                    }
                    if is_junk(trimmed) {
                        summary.junk_blanked += 1;
                        cleaned.push(None);
                    } else {
                        cleaned.push(Some(trimmed));
                    }
                }
            }
        }
        columns.push(Series::new(series.name().clone(), cleaned));
    }
    let trimmed = DataFrame::new(columns)?;

    // ── 3. Drop fully-identical duplicate rows (row order preserved). ─
    // `unique_stable` routes through `df._apply_columns_par(...)` →
    // rayon's POOL, which traps on wasm32-unknown-unknown (no
    // SharedArrayBuffer + COEP/CORP). Server keeps the par version
    // (fast on large frames); wasm gets a serial implementation that
    // avoids rayon entirely. See docs/internal/roadmap-webassembly.md §6
    // for the rayon/threading cliff.
    let before = trimmed.height();
    #[cfg(not(target_arch = "wasm32"))]
    let deduped = trimmed.unique_stable(None, UniqueKeepStrategy::First, None)?;
    #[cfg(target_arch = "wasm32")]
    let deduped = drop_dupe_rows_serial(trimmed)?;
    summary.duplicate_rows_dropped = before - deduped.height();

    Ok((deduped, summary))
}

/// Stable de-dup that walks rows serially. Used on wasm32 where Polars'
/// par_iter-based `unique_stable` traps because rayon's POOL isn't
/// available. Slower than the par version for big frames; fine for the
/// demo cap (5 MB CSV ≈ tens of thousands of rows). Stable: first
/// occurrence of each distinct row-signature kept.
#[cfg(target_arch = "wasm32")]
fn drop_dupe_rows_serial(df: DataFrame) -> Result<DataFrame> {
    use std::collections::HashSet;
    let height = df.height();
    if height < 2 {
        return Ok(df);
    }

    // Per-row signature: `{:?}`-format each cell (correctly distinguishes
    // `Null` from `""` and typed numeric vs string).
    let mut seen: HashSet<Vec<String>> = HashSet::with_capacity(height);
    let mut keep_mask: Vec<bool> = Vec::with_capacity(height);
    let cols = df.get_columns();
    for i in 0..height {
        let sig: Vec<String> = cols
            .iter()
            .map(|c| format!("{:?}", c.get(i).unwrap_or(AnyValue::Null)))
            .collect();
        keep_mask.push(seen.insert(sig));
    }

    // No dupes? Return as-is. Avoids the rebuild cost when the demo
    // file is already clean.
    if keep_mask.iter().all(|&k| k) {
        return Ok(df);
    }

    // Rebuild each Series by walking kept indices per its dtype. The
    // typed extraction sidesteps Polars' `filter` / `take` (which also
    // route through par_iter). Falls back to AnyValue rebuild for
    // dtypes we don't expect in cleaned data (auto_clean only produces
    // String / numeric / bool columns).
    let new_cols: Vec<Series> = cols
        .iter()
        .map(|col| -> Result<Series> {
            let name = col.name().clone();
            match col.dtype() {
                DataType::String => {
                    let ca = col.str()?;
                    let v: Vec<Option<&str>> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| ca.get(i))
                        .collect();
                    Ok(Series::new(name, v))
                }
                DataType::Boolean => {
                    let ca = col.bool()?;
                    let v: Vec<Option<bool>> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| ca.get(i))
                        .collect();
                    Ok(Series::new(name, v))
                }
                DataType::Float64 => {
                    let ca = col.f64()?;
                    let v: Vec<Option<f64>> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| ca.get(i))
                        .collect();
                    Ok(Series::new(name, v))
                }
                DataType::Int64 => {
                    let ca = col.i64()?;
                    let v: Vec<Option<i64>> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| ca.get(i))
                        .collect();
                    Ok(Series::new(name, v))
                }
                _ => {
                    // Fallback: rebuild via AnyValue. Should be unreachable for
                    // auto_clean output; included so any future caller doesn't
                    // silently corrupt unusual dtypes.
                    let values: Vec<AnyValue> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| col.get(i).unwrap_or(AnyValue::Null))
                        .collect();
                    Series::from_any_values_and_dtype(name, &values, col.dtype(), false)
                        .map_err(crate::DataError::from)
                }
            }
        })
        .collect::<Result<Vec<_>>>()?;

    DataFrame::new(new_cols).map_err(crate::DataError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_clean_trims_blanks_and_dedups() {
        let df = df![
            "name" => ["  Alice ", "Bob", "Bob", "  N/A  "],
            "city" => ["Paris", "Lyon", "Lyon", "-"],
        ]
        .unwrap();

        let (out, s) = auto_clean(&df).unwrap();

        // "Bob,Lyon" appears twice → one dropped.
        assert_eq!(out.height(), 3);
        assert_eq!(s.duplicate_rows_dropped, 1);
        assert!(s.cells_trimmed >= 2, "'  Alice ' and '  N/A  ' were padded");
        assert!(s.junk_blanked >= 2, "'N/A' and '-' are junk");

        let names: Vec<Option<&str>> = out
            .column("name")
            .unwrap()
            .str()
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(names[0], Some("Alice")); // whitespace stripped
        assert_eq!(names[2], None); // "N/A" blanked to null
    }
}
