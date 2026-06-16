//! Purpose: detect + execute join keys between two frames — the multi-file
//! differentiator ("the feature that lifts RedPash from a simple cleaner to
//! the tool that democratises multi-file analysis").
//!
//! Scoring is the OVERLAP COEFFICIENT |A∩B| / min(|A|,|B|), deliberately NOT
//! Jaccard: overlap favours the subset (FK→PK) relationships real joins are,
//! where Jaccard penalises asymmetric set sizes. Capped distinct sets keep the
//! TOP-N BY FREQUENCY (not first-N-seen) with an alphabetical tie-break for
//! determinism — frequent values both match autocomplete intent and strengthen
//! the FK→PK overlap signal.

use std::collections::{HashMap, HashSet};

use polars::prelude::*;
use serde::Serialize;

use crate::{DataError, Result};

pub const MAX_UNIQUE: usize = 5000;
// One non-null value suffices — the overlap threshold does the real work
// (the old `5` rejected legitimate single-value joins from a narrow filter).
const MIN_UNIQUE: usize = 1;

#[derive(Debug, Serialize)]
pub struct JoinCandidate {
    pub this_col: String,
    pub other_col: String,
    /// Overlap coefficient (the sort key / FK→PK signal). The UI renders raw
    /// counts, not this.
    pub score: f32,
    pub matches: u32,
    pub this_uniques: u32,
    pub other_uniques: u32,
    pub samples: Vec<String>,
}

pub fn detect_pair(
    this_df: &DataFrame,
    other_df: &DataFrame,
    threshold: f32,
    max_results: usize,
) -> Result<Vec<JoinCandidate>> {
    let this = unique_per_col(this_df, MAX_UNIQUE)?;
    let other = unique_per_col(other_df, MAX_UNIQUE)?;

    let mut out: Vec<JoinCandidate> = Vec::new();
    for (tc, ta) in &this {
        if ta.len() < MIN_UNIQUE {
            continue;
        }
        for (oc, ob) in &other {
            if ob.len() < MIN_UNIQUE {
                continue;
            }
            let (small, large) = if ta.len() <= ob.len() { (ta, ob) } else { (ob, ta) };
            let mut hits = 0u32;
            let mut samples: Vec<String> = Vec::with_capacity(5);
            for v in small {
                if large.contains(v) {
                    hits += 1;
                    if samples.len() < 5 {
                        samples.push(v.clone());
                    }
                }
            }
            let denom = small.len() as f32;
            let score = if denom > 0.0 { hits as f32 / denom } else { 0.0 };
            if score >= threshold {
                out.push(JoinCandidate {
                    this_col: tc.clone(),
                    other_col: oc.clone(),
                    score,
                    matches: hits,
                    this_uniques: ta.len() as u32,
                    other_uniques: ob.len() as u32,
                    samples,
                });
            }
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(max_results);
    Ok(out)
}

/// Materialise the join. Multi-key joins pair the i-th left key with the i-th
/// right key. Both sides' keys cast to String first so dtype mismatches
/// (matricule Int64 vs String) don't 500 — string equality is the right
/// semantics for ID columns anyway.
pub fn execute(
    left: &DataFrame,
    right: &DataFrame,
    left_keys: &[String],
    right_keys: &[String],
    join_type: &str,
) -> Result<DataFrame> {
    if left_keys.is_empty() || left_keys.len() != right_keys.len() {
        return Err(DataError::InvalidSpec(
            "joins.execute needs same-length non-empty key arrays".into(),
        ));
    }
    let jt = match join_type {
        "inner" => JoinType::Inner,
        "left" => JoinType::Left,
        "right" => JoinType::Right,
        "outer" | "full" => JoinType::Full,
        other => return Err(DataError::InvalidSpec(format!("unsupported join type: {other}"))),
    };
    let mut left_c = left.clone();
    let mut right_c = right.clone();
    for k in left_keys {
        let casted = left_c.column(k.as_str()).map_err(DataError::from)?.cast(&DataType::String).map_err(DataError::from)?;
        left_c.with_column(casted).map_err(DataError::from)?;
    }
    for k in right_keys {
        let casted = right_c.column(k.as_str()).map_err(DataError::from)?.cast(&DataType::String).map_err(DataError::from)?;
        right_c.with_column(casted).map_err(DataError::from)?;
    }
    let l: Vec<&str> = left_keys.iter().map(|s| s.as_str()).collect();
    let r: Vec<&str> = right_keys.iter().map(|s| s.as_str()).collect();
    left_c.join(&right_c, l, r, JoinArgs::new(jt), None).map_err(DataError::from)
}

/// Per-column distinct set, capped at `cap`. Over-cap columns keep the
/// TOP-N BY FREQUENCY (alphabetical tie-break → deterministic). Also reused by
/// distinct-for-autocomplete.
pub fn unique_per_col(df: &DataFrame, cap: usize) -> Result<HashMap<String, HashSet<String>>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::with_capacity(df.width());
    for c in df.columns() {
        let name = c.name().to_string();
        let mut counts: HashMap<String, u32> = HashMap::new();
        for i in 0..c.len() {
            let s = match c.get(i).map_err(DataError::from)? {
                AnyValue::Null => continue,
                AnyValue::String(s) => (*s).to_string(),
                AnyValue::StringOwned(s) => s.to_string(),
                other => other.to_string(),
            };
            if !s.is_empty() {
                *counts.entry(s).or_insert(0) += 1;
            }
        }
        if counts.len() <= cap {
            out.insert(name, counts.into_keys().collect());
            continue;
        }
        let mut by_count: Vec<(String, u32)> = counts.into_iter().collect();
        by_count.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        by_count.truncate(cap);
        out.insert(name, by_count.into_iter().map(|(v, _)| v).collect());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_fk_to_pk_overlap_and_ignores_unrelated() {
        // employees.dept_id ⊆ departments.id (a 2-of-2 subset → score 1.0),
        // while name/label columns don't overlap.
        let emp = df![
            "dept_id" => ["D1", "D2", "D1", "D2"],
            "name" => ["Alice", "Bob", "Carol", "Dan"],
        ]
        .unwrap();
        let dept = df![
            "id" => ["D1", "D2", "D3"],
            "label" => ["Eng", "Sales", "Ops"],
        ]
        .unwrap();
        let cands = detect_pair(&emp, &dept, 0.3, 20).unwrap();
        let top = cands.first().expect("a candidate");
        assert_eq!((top.this_col.as_str(), top.other_col.as_str()), ("dept_id", "id"));
        assert!((top.score - 1.0).abs() < 1e-6, "FK fully covered → score 1.0");
        // no name↔label candidate survives the threshold
        assert!(!cands.iter().any(|c| c.this_col == "name" && c.other_col == "label"));
    }

    #[test]
    fn execute_inner_join_links_rows_across_dtype_mismatch() {
        // left key Int64, right key String — must still join (cast to String).
        let left = df!["k" => [1i64, 2, 3], "v" => ["a", "b", "c"]].unwrap();
        let right = df!["k" => ["1", "2"], "w" => ["x", "y"]].unwrap();
        let out = execute(&left, &right, &["k".into()], &["k".into()], "inner").unwrap();
        assert_eq!(out.height(), 2);
        assert!(out.get_column_names().iter().any(|n| n.as_str() == "w"));
    }
}
