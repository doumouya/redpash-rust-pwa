//! Detect candidate join keys between two DataFrames.
//!
//! Algorithm (port of clarna-django's `detect_join_keys`):
//!   1. For each column in each frame, collect a HashSet of unique
//!      non-empty stringified values, capped at `MAX_UNIQUE`.
//!   2. Score every (this_col, other_col) pair by overlap coefficient:
//!         |A ∩ B| / min(|A|, |B|)
//!      This favours subset relationships (FK → PK) over Jaccard, which
//!      penalises asymmetric sizes.
//!   3. Drop pairs below `threshold` or where either set is tiny (<5
//!      unique values), sort descending by score, cap at `max_results`.
//!
//! The result for the UI is one `JoinCandidate` per surviving pair,
//! enriched with up to 5 sample-matching values so the user can verify
//! the join would actually link real rows.

use crate::{DataError, Result};
use polars::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const MAX_UNIQUE: usize = 5000;
// One non-null value is enough — the overlap threshold below does the
// real work. The old `5` rejected legitimate single-value joins
// produced by a narrow filter (e.g. matricule = 1243).
const MIN_UNIQUE: usize = 1;

#[derive(Debug, Serialize)]
pub struct JoinCandidate {
    pub this_col:  String,
    pub other_col: String,
    /// Overlap coefficient — `matches / min(this_uniques, other_uniques)`.
    /// Used as the sort key (FK→PK signal: a 100-row test export fully
    /// covered by a 100k-row prod export ranks first). Invisible to the
    /// end user; the frontend renders raw counts instead.
    pub score:     f32,
    /// Count of overlapping values within the capped unique sets.
    pub matches:   u32,
    /// Unique-value count on the base file's column (after MAX_UNIQUE
    /// cap). Powers the user-facing "X of N base values match" string.
    pub this_uniques:  u32,
    /// Unique-value count on the other file's column (after MAX_UNIQUE
    /// cap). Powers the "(other file has N unique)" tail of the same
    /// string — gives the user cardinality at a glance.
    pub other_uniques: u32,
    pub samples:   Vec<String>,
}

pub fn detect_pair(
    this_df:     &DataFrame,
    other_df:    &DataFrame,
    threshold:   f32,
    max_results: usize,
) -> Result<Vec<JoinCandidate>> {
    let this  = unique_per_col(this_df,  MAX_UNIQUE)?;
    let other = unique_per_col(other_df, MAX_UNIQUE)?;

    let mut out: Vec<JoinCandidate> = Vec::new();
    for (tc, ta) in &this {
        if ta.len() < MIN_UNIQUE { continue; }
        for (oc, ob) in &other {
            if ob.len() < MIN_UNIQUE { continue; }
            let (small, large) = if ta.len() <= ob.len() { (ta, ob) } else { (ob, ta) };
            let mut hits = 0u32;
            let mut samples: Vec<String> = Vec::with_capacity(5);
            for v in small {
                if large.contains(v) {
                    hits += 1;
                    if samples.len() < 5 { samples.push(v.clone()); }
                }
            }
            let denom = small.len() as f32;
            let score = if denom > 0.0 { hits as f32 / denom } else { 0.0 };
            if score >= threshold {
                out.push(JoinCandidate {
                    this_col:      tc.clone(),
                    other_col:     oc.clone(),
                    score,
                    matches:       hits,
                    this_uniques:  ta.len() as u32,
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

/// Materialise the join. Multi-key (compound) joins are supported by
/// passing matching-length slices; the i-th left key pairs with the
/// i-th right key.
///
/// Both sides' key columns are cast to `String` before the join so
/// mismatched dtypes (e.g. `matricule` parsed as Int64 on one side and
/// String on the other) don't blow up the request — string equality
/// is the right semantics for ID-style columns anyway.
pub fn execute(
    left:       &DataFrame,
    right:      &DataFrame,
    left_keys:  &[String],
    right_keys: &[String],
    join_type:  &str,
) -> Result<DataFrame> {
    if left_keys.is_empty() || left_keys.len() != right_keys.len() {
        return Err(DataError::InvalidSpec(
            "joins.execute needs same-length non-empty key arrays".into()));
    }
    let jt = match join_type {
        "inner"          => JoinType::Inner,
        "left"           => JoinType::Left,
        "right"          => JoinType::Right,
        "outer" | "full" => JoinType::Full,
        other            => return Err(DataError::InvalidSpec(
            format!("unsupported join type: {other}"))),
    };

    // Cast each key column to String on both sides. `with_column` here
    // replaces the column in-place since names match.
    let mut left_c  = left.clone();
    let mut right_c = right.clone();
    for k in left_keys {
        let casted = left_c.column(k.as_str()).map_err(DataError::from)?
            .cast(&DataType::String).map_err(DataError::from)?;
        left_c.with_column(casted).map_err(DataError::from)?;
    }
    for k in right_keys {
        let casted = right_c.column(k.as_str()).map_err(DataError::from)?
            .cast(&DataType::String).map_err(DataError::from)?;
        right_c.with_column(casted).map_err(DataError::from)?;
    }

    let l: Vec<&str> = left_keys.iter().map(|s| s.as_str()).collect();
    let r: Vec<&str> = right_keys.iter().map(|s| s.as_str()).collect();
    left_c.join(&right_c, l, r, JoinArgs::new(jt))
        .map_err(DataError::from)
}

fn unique_per_col(df: &DataFrame, cap: usize) -> Result<HashMap<String, HashSet<String>>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::with_capacity(df.width());
    for c in df.get_columns() {
        let name = c.name().to_string();
        let mut set: HashSet<String> = HashSet::new();
        for i in 0..c.len() {
            if set.len() >= cap { break; }
            let v = c.get(i).map_err(DataError::from)?;
            let s = match v {
                AnyValue::Null            => continue,
                AnyValue::String(s)       => (*s).to_string(),
                AnyValue::StringOwned(s)  => s.to_string(),
                other                     => other.to_string(),
            };
            if !s.is_empty() { set.insert(s); }
        }
        out.insert(name, set);
    }
    Ok(out)
}
