//! Doc: docs/internal/code/backend/data/dedup.md
//! Duplicate-row detection for the cleaner's dedup tool.
//!
//! Two modes:
//!   • Full-row : all column values must match (uses `df.is_duplicated`).
//!   • By column: only the named subset must match (`df.select(cols)
//!                .is_duplicated`).
//!
//! The returned report is sorted by the key columns so consecutive rows
//! with identical keys form a group — the frontend reuses this to draw
//! the "first occurrence stays, rest are pre-checked for deletion" UX.
//! We cap at `max_rows` so the preview modal never tries to render
//! millions of rows; the caller is told whether truncation occurred.

use crate::{DataError, Result};
use polars::prelude::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct DedupReport {
    /// Header for the preview mini-table — every column in the frame.
    pub columns: Vec<String>,
    /// The dedup key (empty for full-row mode).
    pub by: Vec<String>,
    /// Index into `columns` for each `by` entry; saves the frontend a lookup.
    pub by_indices: Vec<u32>,
    /// Duplicate rows sorted by the key columns. The first row of each
    /// run shares its key with the next — the frontend pre-checks all
    /// rows whose predecessor has the same key.
    pub rows: Vec<DupRow>,
    pub total_groups: u32,
    pub total_rows: u32,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct DupRow {
    /// 0-based row index in the current view (after prior steps).
    pub index: u32,
    pub cells: Vec<Option<String>>,
}

pub fn detect(df: &DataFrame, by: &[String], max_rows: usize) -> Result<DedupReport> {
    let all_names: Vec<String> = df
        .get_columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    // Resolve `by` indices and short-circuit invalid names.
    let by_indices: Vec<u32> = by
        .iter()
        .map(|name| {
            all_names
                .iter()
                .position(|n| n == name)
                .ok_or_else(|| DataError::InvalidSpec(format!("unknown column: {name}")))
                .map(|i| i as u32)
        })
        .collect::<Result<Vec<_>>>()?;

    // Build the duplicate mask. `is_duplicated` marks EVERY row whose
    // (sub-)key occurs more than once — including the first occurrence.
    let mask: BooleanChunked = if by.is_empty() {
        df.is_duplicated().map_err(DataError::from)?
    } else {
        let keys: Vec<&str> = by.iter().map(|s| s.as_str()).collect();
        df.select(keys)
            .map_err(DataError::from)?
            .is_duplicated()
            .map_err(DataError::from)?
    };

    // Collect (original_index, cells) for every marked row.
    let mut dups: Vec<DupRow> = Vec::new();
    for (i, marked) in mask.into_iter().enumerate() {
        if matches!(marked, Some(true)) {
            let cells = stringify_row(df, i)?;
            dups.push(DupRow {
                index: i as u32,
                cells,
            });
        }
    }
    let total_rows = dups.len() as u32;

    // Sort by key columns so groups are contiguous. Falls back to full
    // row when by is empty.
    let key_idx: Vec<usize> = if by.is_empty() {
        (0..all_names.len()).collect()
    } else {
        by_indices.iter().map(|&i| i as usize).collect()
    };
    dups.sort_by(|a, b| compare_by_keys(&a.cells, &b.cells, &key_idx));

    // Count groups by counting key-changes in the sorted list.
    let total_groups: u32 = if dups.is_empty() {
        0
    } else {
        let mut count = 1u32;
        for w in dups.windows(2) {
            if compare_by_keys(&w[0].cells, &w[1].cells, &key_idx) != std::cmp::Ordering::Equal {
                count += 1;
            }
        }
        count
    };

    // Cap for the preview modal.
    let truncated = dups.len() > max_rows;
    dups.truncate(max_rows);

    Ok(DedupReport {
        columns: all_names,
        by: by.to_vec(),
        by_indices,
        rows: dups,
        total_groups,
        total_rows,
        truncated,
    })
}

fn stringify_row(df: &DataFrame, i: usize) -> Result<Vec<Option<String>>> {
    let mut row = Vec::with_capacity(df.width());
    for c in df.get_columns() {
        let val = c.get(i).map_err(DataError::from)?;
        row.push(match val {
            AnyValue::Null => None,
            AnyValue::String(s) => Some((*s).to_string()),
            AnyValue::StringOwned(s) => Some(s.to_string()),
            other => Some(other.to_string()),
        });
    }
    Ok(row)
}

fn compare_by_keys(
    a: &[Option<String>],
    b: &[Option<String>],
    keys: &[usize],
) -> std::cmp::Ordering {
    for &i in keys {
        let av = a.get(i).and_then(|c| c.as_deref()).unwrap_or("");
        let bv = b.get(i).and_then(|c| c.as_deref()).unwrap_or("");
        let ord = av.cmp(bv);
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}
