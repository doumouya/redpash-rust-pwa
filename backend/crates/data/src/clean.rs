//! Purpose: auto_clean — the conservative, always-safe transforms RedPash
//! applies with no human in the loop (powers the landing-page demo). Narrow by
//! design: only fixes that never lose real data and never make a judgment call:
//!   1. trim surrounding whitespace from string cells;
//!   2. blank obvious junk (the unified SENTINELS) + whitespace-only to null;
//!   3. drop fully-identical duplicate rows.
//! The risky 10% (which rows to drop on a key, which columns to cast, ambiguous
//! dates) stays the interactive cleaner's job.
//!
//! The dedup is cfg-split: server uses Polars unique_stable (rayon par_iter);
//! wasm walks rows serially because rayon's POOL traps on wasm32 (no
//! SharedArrayBuffer/COEP) — and the rebuild avoids filter/take, which also
//! route through par_iter.

use polars::prelude::*;
use serde::Serialize;

use crate::{sentinels, Result};

#[derive(Debug, Default, Clone, Serialize)]
pub struct CleanSummary {
    pub cells_trimmed: usize,
    pub junk_blanked: usize,
    pub duplicate_rows_dropped: usize,
}

impl CleanSummary {
    pub fn is_noop(&self) -> bool {
        self.cells_trimmed == 0 && self.junk_blanked == 0 && self.duplicate_rows_dropped == 0
    }
}

/// Is `value` (already trimmed) junk safe to blank? Routes through the unified
/// sentinel vocabulary.
fn is_junk(value: &str) -> bool {
    value.is_empty() || sentinels::is_sentinel(value)
}

pub fn auto_clean(df: &DataFrame) -> Result<(DataFrame, CleanSummary)> {
    let mut summary = CleanSummary::default();

    // 1 + 2: per string column, trim then blank junk to null.
    let mut columns: Vec<Column> = Vec::with_capacity(df.width());
    for series in df.columns() {
        if series.dtype() != &DataType::String {
            columns.push(series.clone());
            continue;
        }
        let chunked = series.as_materialized_series().str()?;
        let mut cleaned: Vec<Option<&str>> = Vec::with_capacity(chunked.len());
        for cell in chunked.iter() {
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
        columns.push(Series::new(series.name().clone(), cleaned).into_column());
    }
    let trimmed = DataFrame::new_infer_height(columns)?;

    // 3: drop fully-identical duplicate rows (row order preserved).
    let before = trimmed.height();
    #[cfg(not(target_arch = "wasm32"))]
    let deduped = trimmed.unique_stable(None, UniqueKeepStrategy::First, None)?;
    #[cfg(target_arch = "wasm32")]
    let deduped = drop_dupe_rows_serial(trimmed)?;
    summary.duplicate_rows_dropped = before - deduped.height();

    Ok((deduped, summary))
}

/// Serial stable de-dup for wasm32 (rayon's POOL is unavailable). Rebuilds each
/// Series by typed index-walk to also sidestep filter/take (par_iter).
#[cfg(target_arch = "wasm32")]
fn drop_dupe_rows_serial(df: DataFrame) -> Result<DataFrame> {
    use std::collections::HashSet;
    let height = df.height();
    if height < 2 {
        return Ok(df);
    }
    let mut seen: HashSet<Vec<String>> = HashSet::with_capacity(height);
    let mut keep_mask: Vec<bool> = Vec::with_capacity(height);
    let cols = df.columns();
    for i in 0..height {
        let sig: Vec<String> =
            cols.iter().map(|c| format!("{:?}", c.get(i).unwrap_or(AnyValue::Null))).collect();
        keep_mask.push(seen.insert(sig));
    }
    if keep_mask.iter().all(|&k| k) {
        return Ok(df);
    }
    let new_cols: Vec<Column> = cols
        .iter()
        .map(|col| -> Result<Column> {
            let name = col.name().clone();
            match col.dtype() {
                DataType::String => {
                    let ca = col.str()?;
                    let v: Vec<Option<&str>> =
                        (0..height).filter(|&i| keep_mask[i]).map(|i| ca.get(i)).collect();
                    Ok(Series::new(name, v).into_column())
                }
                DataType::Boolean => {
                    let ca = col.bool()?;
                    let v: Vec<Option<bool>> =
                        (0..height).filter(|&i| keep_mask[i]).map(|i| ca.get(i)).collect();
                    Ok(Series::new(name, v).into_column())
                }
                DataType::Float64 => {
                    let ca = col.f64()?;
                    let v: Vec<Option<f64>> =
                        (0..height).filter(|&i| keep_mask[i]).map(|i| ca.get(i)).collect();
                    Ok(Series::new(name, v).into_column())
                }
                DataType::Int64 => {
                    let ca = col.i64()?;
                    let v: Vec<Option<i64>> =
                        (0..height).filter(|&i| keep_mask[i]).map(|i| ca.get(i)).collect();
                    Ok(Series::new(name, v).into_column())
                }
                _ => {
                    let values: Vec<AnyValue> = (0..height)
                        .filter(|&i| keep_mask[i])
                        .map(|i| col.get(i).unwrap_or(AnyValue::Null))
                        .collect();
                    Series::from_any_values_and_dtype(name, &values, col.dtype(), false)
                        .map(|s| s.into_column())
                        .map_err(crate::DataError::from)
                }
            }
        })
        .collect::<Result<Vec<_>>>()?;
    DataFrame::new_infer_height(new_cols).map_err(crate::DataError::from)
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
        assert_eq!(out.height(), 3); // "Bob,Lyon" twice → one dropped
        assert_eq!(s.duplicate_rows_dropped, 1);
        assert!(s.cells_trimmed >= 2);
        assert!(s.junk_blanked >= 2); // "N/A" and "-"
        let names: Vec<Option<&str>> = out.column("name").unwrap().str().unwrap().iter().collect();
        assert_eq!(names[0], Some("Alice"));
        assert_eq!(names[2], None); // "N/A" → null
    }

    #[test]
    fn fr_sentinel_is_blanked() {
        // The unified-list win: "inconnu" is junk auto_clean blanks.
        let df = df!["c" => ["Paris", "inconnu", "Lyon"]].unwrap();
        let (out, s) = auto_clean(&df).unwrap();
        assert!(s.junk_blanked >= 1);
        let c: Vec<Option<&str>> = out.column("c").unwrap().str().unwrap().iter().collect();
        assert_eq!(c[1], None);
    }
}
