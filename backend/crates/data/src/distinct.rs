//! Doc: docs/internal/code/backend/data/distinct.md
//! Single-column distinct values — drives filter-predicate
//! autocomplete on the workspace's filter panel.
//!
//! Cousin of `joins::unique_per_col`, deliberately separate: that one
//! is pairwise across every column in the frame (joins detector
//! needs that shape), this one scans exactly one column. Calling the
//! pairwise function for a single-column lookup would scan N-1
//! columns for nothing on every request.
//!
//! Top-N-by-frequency at MAX_UNIQUE=5000 (Torv ↔ Gus 2026-05-24).
//! When a column has more than the cap, the kept values are the most
//! frequent — which is what the user is most likely to type. Ties
//! break alphabetically so the cut is deterministic across runs.

use crate::{DataError, Result};
use polars::prelude::*;
use std::collections::HashMap;

/// Hard upper bound on the kept-value count, matching
/// `joins::MAX_UNIQUE`. Beyond that the response carries
/// `truncated: true` so the frontend can show "5000+ values" rather
/// than promise completeness.
pub const MAX_UNIQUE: usize = 5_000;

/// One column's distinct-value result. `values` is the post-`q`-
/// filter, sorted (alphabetical ascending), length-capped slice.
/// `total` is the pre-`q` distinct count (so the frontend can show
/// "X of N matched"); `truncated` flips true when the underlying
/// distinct set hit `MAX_UNIQUE` and the kept set is a top-N pick.
#[derive(Debug, Clone)]
pub struct DistinctResult {
    pub values: Vec<String>,
    pub total: u32,
    pub truncated: bool,
}

/// Build a distinct-value slice for one column. Case-insensitive
/// substring match on `q` (empty `q` → no filter). `limit` caps the
/// returned `values.len()`; pre-`q` `total` is reported separately.
///
/// `col` not present in `df` returns `Err(NotFound)` — the route
/// handler maps that to a clean 404 with the column name in the
/// error message.
pub fn for_column(
    df: &DataFrame,
    col: &str,
    q: Option<&str>,
    limit: usize,
) -> Result<DistinctResult> {
    let column = df
        .column(col)
        .map_err(|_| DataError::NotFound(format!("column {col} not in frame")))?;

    // First pass: count occurrences. HashMap grows to the column's
    // full distinct cardinality. At dev-DB scale (P99 ≈ 17k distincts
    // on a 400k-row file per the audit_distincts walk) this is tens
    // of KB resident per call — comfortable.
    let mut counts: HashMap<String, u32> = HashMap::new();
    for i in 0..column.len() {
        let v = column.get(i).map_err(DataError::from)?;
        let s = match v {
            AnyValue::Null => continue,
            AnyValue::String(s) => (*s).to_string(),
            AnyValue::StringOwned(s) => s.to_string(),
            other => other.to_string(),
        };
        if !s.is_empty() {
            *counts.entry(s).or_insert(0) += 1;
        }
    }
    let total = counts.len() as u32;
    let truncated = counts.len() > MAX_UNIQUE;

    // Select the top-N-by-frequency when over cap. Tie-break
    // alphabetically so the kept set is deterministic.
    let mut universe: Vec<String> = if truncated {
        let mut by_count: Vec<(String, u32)> = counts.into_iter().collect();
        by_count.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        by_count.truncate(MAX_UNIQUE);
        by_count.into_iter().map(|(v, _)| v).collect()
    } else {
        counts.into_keys().collect()
    };

    // Final display order is alphabetical ascending — the dropdown
    // reads stable regardless of how the user typed `q`.
    universe.sort();

    let needle = q
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let mut values: Vec<String> = universe
        .into_iter()
        .filter(|v| match &needle {
            Some(n) => v.to_ascii_lowercase().contains(n.as_str()),
            None => true,
        })
        .collect();
    if values.len() > limit {
        values.truncate(limit);
    }

    Ok(DistinctResult {
        values,
        total,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_q_returns_sorted_distincts_capped_by_limit() {
        let df = df![
            "city" => ["Paris", "Lyon", "Paris", "Nice", "Lyon", "Paris"],
        ]
        .unwrap();
        let r = for_column(&df, "city", None, 100).unwrap();
        assert_eq!(r.values, vec!["Lyon", "Nice", "Paris"]);
        assert_eq!(r.total, 3);
        assert!(!r.truncated);
    }

    #[test]
    fn q_is_case_insensitive_substring() {
        let df = df![
            "city" => ["Paris", "Lyon", "Nice", "Marseille"],
        ]
        .unwrap();
        let r = for_column(&df, "city", Some("ar"), 100).unwrap();
        // "Paris" and "Marseille" both contain "ar" case-insensitively.
        assert_eq!(r.values, vec!["Marseille", "Paris"]);
        // total is the pre-q distinct count, not the matched count.
        assert_eq!(r.total, 4);
    }

    #[test]
    fn limit_caps_values_but_not_total() {
        let df = df![
            "n" => ["a", "b", "c", "d", "e"],
        ]
        .unwrap();
        let r = for_column(&df, "n", None, 2).unwrap();
        assert_eq!(r.values.len(), 2);
        assert_eq!(r.values, vec!["a", "b"]);
        assert_eq!(r.total, 5);
        assert!(!r.truncated);
    }

    #[test]
    fn nulls_and_empty_strings_are_skipped() {
        let df = df![
            "c" => [Some("x"), None, Some(""), Some("y"), Some("x")],
        ]
        .unwrap();
        let r = for_column(&df, "c", None, 100).unwrap();
        assert_eq!(r.values, vec!["x", "y"]);
        assert_eq!(r.total, 2);
    }

    #[test]
    fn missing_column_is_not_found() {
        let df = df!["a" => [1i64, 2, 3]].unwrap();
        let err = for_column(&df, "nope", None, 10).unwrap_err();
        match err {
            DataError::NotFound(msg) => assert!(msg.contains("nope")),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn over_cap_keeps_top_n_by_frequency_and_sets_truncated() {
        // MAX_UNIQUE + 1 distinct values: the rarest one (single
        // occurrence) is dropped, the cap survivors are the frequent
        // ones. Build values v0..=vN where v0 is the loser.
        let mut col: Vec<String> = Vec::new();
        // v0 appears once (the rarest → cut).
        col.push("v0".to_string());
        // v1..=vN each appear twice (kept).
        for i in 1..=MAX_UNIQUE {
            let s = format!("v{i}");
            col.push(s.clone());
            col.push(s);
        }
        let series = Series::new("k".into(), col);
        let df = DataFrame::new_infer_height(vec![series.into_column()]).unwrap();
        let r = for_column(&df, "k", None, MAX_UNIQUE).unwrap();
        assert!(r.truncated);
        assert_eq!(r.total, (MAX_UNIQUE + 1) as u32);
        assert_eq!(r.values.len(), MAX_UNIQUE);
        // the single-occurrence "v0" must have been cut.
        assert!(!r.values.iter().any(|v| v == "v0"));
    }
}
