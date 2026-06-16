//! Purpose: the file-level CLEANNESS SCORE (0-100) — the product's first
//! promise (the instant quality report). Two tiers, ported verbatim because
//! the calibration is the moat:
//!
//!   score = value_quality x structural_integrity
//!
//! value_quality (0-100) = 0.35*completeness + 0.25*type_consistency
//!                       + 0.25*value_hygiene + 0.15*row_uniqueness
//! structural_integrity (0-1) = min(shape, encoding, header) — a GATE, not a
//!   fifth averaged component: a file parsed into one bogus column is 0%
//!   usable no matter how "complete" that column looks, so structure caps the
//!   ceiling rather than diluting into an average.
//!
//! Sentinels route through the unified `crate::sentinels` (one list now).

use std::collections::{HashMap, HashSet};

use polars::prelude::*;
use shared::file::ColumnMeta;

use crate::{sentinels, DataError, Result};

/// One sentinel value discovered across the frame, with per-column counts.
/// `value` keeps original casing (UI shows what's on disk); `canonical` is the
/// trim+lowercase key bucketing "N/A"/"n/a"/" N/A " together.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SentinelOccurrence {
    pub value: String,
    pub canonical: String,
    pub total: u64,
    pub columns: Vec<(String, u64)>,
}

/// The per-call canonical vocabulary: the unified list ∪ the caller's extras
/// (learned + global sentinels), each canonicalised. The owned vec must
/// outlive the borrowed set.
fn vocabulary(extras: &[String]) -> (Vec<String>, HashSet<&'static str>) {
    let extras_lower: Vec<String> = extras
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let base: HashSet<&'static str> = sentinels::SENTINELS.iter().copied().collect();
    (extras_lower, base)
}

fn matches_vocab(canon: &str, base: &HashSet<&str>, extras_lower: &[String]) -> bool {
    base.contains(canon) || extras_lower.iter().any(|e| e == canon)
}

/// Scan string columns for sentinel cells (∪ extras). One entry per distinct
/// value as found (casing preserved), sorted by total desc then value asc.
pub fn find_sentinels(df: &DataFrame, extras: &[String]) -> Vec<SentinelOccurrence> {
    let (extras_lower, base) = vocabulary(extras);
    let mut buckets: HashMap<String, (String, u64, HashMap<String, u64>)> = HashMap::new();
    for series in df.columns() {
        if !matches!(series.dtype(), DataType::String) {
            continue;
        }
        let cname = series.name().to_string();
        for i in 0..series.len() {
            let raw = match series.get(i) {
                Ok(AnyValue::String(s)) => s.to_string(),
                Ok(AnyValue::StringOwned(s)) => s.to_string(),
                _ => continue,
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let canon = trimmed.to_ascii_lowercase();
            if !matches_vocab(&canon, &base, &extras_lower) {
                continue;
            }
            let entry = buckets.entry(raw.clone()).or_insert_with(|| (canon, 0u64, HashMap::new()));
            entry.1 += 1;
            *entry.2.entry(cname.clone()).or_insert(0u64) += 1;
        }
    }
    let mut out: Vec<SentinelOccurrence> = buckets
        .into_iter()
        .map(|(value, (canonical, total, cols_map))| {
            let mut cols: Vec<(String, u64)> = cols_map.into_iter().collect();
            cols.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            SentinelOccurrence { value, canonical, total, columns: cols }
        })
        .collect();
    out.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.value.cmp(&b.value)));
    out
}

/// Full per-file breakdown — every sub-score feeding the blend.
#[derive(Debug, Clone, Copy)]
pub struct CleannessReport {
    pub score: f32,
    pub completeness: f32,
    pub type_consistency: f32,
    pub value_hygiene: f32,
    pub row_uniqueness: f32,
    pub value_quality: f32,
    pub shape_integrity: f32,
    pub encoding_integrity: f32,
    pub header_integrity: f32,
    pub structural: f32,
}

/// File-level cleanness (0-100), or None for an empty frame.
pub fn cleanness(df: &DataFrame, columns: &[ColumnMeta], extras: &[String]) -> Option<f32> {
    cleanness_report(df, columns, extras).map(|r| r.score)
}

pub fn cleanness_report(
    df: &DataFrame,
    columns: &[ColumnMeta],
    extras: &[String],
) -> Option<CleannessReport> {
    if df.width() == 0 || df.height() == 0 || columns.is_empty() {
        return None;
    }
    let completeness = completeness_score(columns);
    let type_consistency = type_consistency_score(df, columns);
    let value_hygiene = value_hygiene_score(df, extras);
    let row_uniqueness = row_uniqueness_score(df);
    let value_quality =
        0.35 * completeness + 0.25 * type_consistency + 0.25 * value_hygiene + 0.15 * row_uniqueness;

    let shape = shape_integrity(df);
    let encoding = encoding_integrity(df);
    let header = header_integrity(df);
    let structural = shape.min(encoding).min(header);

    Some(CleannessReport {
        score: (value_quality * structural).clamp(0.0, 100.0),
        completeness,
        type_consistency,
        value_hygiene,
        row_uniqueness,
        value_quality,
        shape_integrity: shape,
        encoding_integrity: encoding,
        header_integrity: header,
        structural,
    })
}

fn completeness_score(columns: &[ColumnMeta]) -> f32 {
    let sum: f32 = columns
        .iter()
        .map(|c| {
            if c.dtype == "empty" {
                0.0
            } else {
                (100.0 - c.null_pct.unwrap_or(0.0).clamp(0.0, 100.0)).clamp(0.0, 100.0)
            }
        })
        .sum();
    sum / columns.len() as f32
}

fn type_consistency_score(df: &DataFrame, columns: &[ColumnMeta]) -> f32 {
    if columns.is_empty() {
        return 100.0;
    }
    let mut sum = 0.0f32;
    for cm in columns {
        let storage = cm.dtype.as_str();
        let intent = cm.semantic_dtype.as_str();
        if storage != "string" || intent == "string" || intent == "empty" {
            sum += 100.0;
            continue;
        }
        let Ok(c) = df.column(&cm.name) else {
            sum += 100.0;
            continue;
        };
        let (mut total, mut clean) = (0u64, 0u64);
        for i in 0..c.len() {
            let Some(raw) = cell_str(c, i) else { continue };
            let t = raw.trim();
            if t.is_empty() {
                continue;
            }
            total += 1;
            let ok = match intent {
                "float" | "int" => is_clean_numeric(t),
                "date" => is_clean_iso_date(t),
                "bool" => is_clean_bool(t),
                _ => true,
            };
            if ok {
                clean += 1;
            }
        }
        sum += if total == 0 { 100.0 } else { 100.0 * clean as f32 / total as f32 };
    }
    sum / columns.len() as f32
}

fn is_clean_numeric(s: &str) -> bool {
    s.parse::<f64>().is_ok()
}

fn is_clean_iso_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[1].len())
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[2].len())
        && parts[2].chars().all(|c| c.is_ascii_digit())
}

fn is_clean_bool(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "true" | "false")
}

fn value_hygiene_score(df: &DataFrame, extras: &[String]) -> f32 {
    let (extras_lower, base) = vocabulary(extras);
    let (mut total, mut clean) = (0u64, 0u64);
    for c in df.columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        for i in 0..c.len() {
            let Some(raw) = cell_str(c, i) else { continue };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            total += 1;
            let padded = raw.len() != trimmed.len();
            let is_sentinel = matches_vocab(&trimmed.to_ascii_lowercase(), &base, &extras_lower);
            if !padded && !is_sentinel {
                clean += 1;
            }
        }
    }
    if total == 0 {
        100.0
    } else {
        100.0 * clean as f32 / total as f32
    }
}

fn row_uniqueness_score(df: &DataFrame) -> f32 {
    let rows = df.height();
    if rows == 0 {
        return 100.0;
    }
    let cols = df.columns();
    let mut seen: HashSet<Vec<Option<String>>> = HashSet::with_capacity(rows);
    for i in 0..rows {
        let key: Vec<Option<String>> = cols.iter().map(|c| c.get(i).ok().and_then(av_to_owned)).collect();
        seen.insert(key);
    }
    100.0 * seen.len() as f32 / rows as f32
}

/// Parse-shape integrity: a single-column frame whose lone column consistently
/// (>=80% modal) splits into m>=2 fields was under-parsed → 1/m. Multi-column
/// frames → 1.0.
fn shape_integrity(df: &DataFrame) -> f32 {
    if df.width() != 1 {
        return 1.0;
    }
    let Some(c) = df.columns().first() else {
        return 1.0;
    };
    if !matches!(c.dtype(), DataType::String) {
        return 1.0;
    }
    const DELIMS: [char; 4] = [',', ';', '\t', '|'];
    let mut worst = 1.0f32;
    for d in DELIMS {
        let step = (c.len() / 300).max(1);
        let mut counts: HashMap<usize, u32> = HashMap::new();
        let (mut sampled, mut i) = (0u32, 0usize);
        while i < c.len() && sampled < 300 {
            if let Some(v) = cell_str(c, i) {
                if !v.trim().is_empty() {
                    sampled += 1;
                    *counts.entry(v.split(d).count()).or_insert(0) += 1;
                }
            }
            i += step;
        }
        if sampled == 0 {
            continue;
        }
        let (&modal, &freq) = counts.iter().max_by_key(|(_, &n)| n).unwrap();
        if modal >= 2 && freq as f32 / sampled as f32 >= 0.8 {
            worst = worst.min(1.0 / modal as f32);
        }
    }
    worst
}

fn header_integrity(df: &DataFrame) -> f32 {
    if df.width() != 1 {
        return 1.0;
    }
    let Some(c) = df.columns().first() else {
        return 1.0;
    };
    let name = c.name().trim();
    let lower = name.to_ascii_lowercase();
    let junk = name.is_empty()
        || lower == "sep"
        || lower.starts_with("sep=")
        || name.starts_with('#')
        || name.contains(": ");
    if junk {
        0.5
    } else {
        1.0
    }
}

/// French double-decode mojibake signatures (UTF-8 read as latin-1): `Ã©` was
/// `é`, etc. Valid UTF-8 themselves, so the text looks intact but is garbage.
const MOJIBAKE_SIGS: &[&str] = &["Ã©", "Ã¨", "Ãª", "Ã ", "Ã§", "Ã®", "Ã´", "Ã¢", "Ã¹", "Ã»"];

fn encoding_integrity(df: &DataFrame) -> f32 {
    let (mut total, mut damaged) = (0u64, 0u64);
    for c in df.columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        for i in 0..c.len() {
            let Some(v) = cell_str(c, i) else { continue };
            total += 1;
            if v.contains('\u{FFFD}') || MOJIBAKE_SIGS.iter().any(|s| v.contains(s)) {
                damaged += 1;
            }
        }
    }
    if total == 0 {
        1.0
    } else {
        1.0 - damaged as f32 / total as f32
    }
}

fn cell_str(c: &Column, i: usize) -> Option<String> {
    match c.get(i) {
        Ok(AnyValue::String(s)) => Some(s.to_string()),
        Ok(AnyValue::StringOwned(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn av_to_owned(v: AnyValue) -> Option<String> {
    match v {
        AnyValue::Null => None,
        AnyValue::String(s) => Some(s.to_string()),
        AnyValue::StringOwned(s) => Some(s.to_string()),
        other => Some(other.to_string()),
    }
}

/// Count rows where every column is null — cross-column, can't be derived from
/// per-column null_pct. Drives the drop-nulls form's context surface.
pub fn count_fully_null_rows(df: &DataFrame) -> u64 {
    let n = df.height();
    if n == 0 || df.width() == 0 {
        return 0;
    }
    let cols = df.columns();
    let mut count = 0u64;
    for i in 0..n {
        if cols.iter().all(|c| matches!(c.get(i), Ok(AnyValue::Null))) {
            count += 1;
        }
    }
    count
}

/// Up to `limit` distinct non-null values from a column, sorted.
pub fn unique_values(df: &DataFrame, col: &str, limit: usize) -> Result<Vec<String>> {
    let column = df.column(col).map_err(DataError::from)?;
    let scan_cap = limit.saturating_mul(3).max(limit);
    let mut set: HashSet<String> = HashSet::new();
    for i in 0..column.len() {
        if set.len() >= scan_cap {
            break;
        }
        let s = match column.get(i).map_err(DataError::from)? {
            AnyValue::Null => continue,
            AnyValue::String(s) => (*s).to_string(),
            AnyValue::StringOwned(s) => s.to_string(),
            other => other.to_string(),
        };
        if !s.is_empty() {
            set.insert(s);
        }
    }
    let mut vec: Vec<String> = set.into_iter().collect();
    vec.sort();
    vec.truncate(limit);
    Ok(vec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dtype;

    fn report(text: &str) -> CleannessReport {
        let df = crate::parse::from_text(text).unwrap();
        let cols = dtype::summarize(&df).unwrap();
        cleanness_report(&df, &cols, &[]).unwrap()
    }

    #[test]
    fn a_clean_file_scores_high() {
        let r = report("id,name,amount\n1,Alice,10.5\n2,Bob,20.0\n3,Carol,33.9\n");
        assert!(r.score > 95.0, "clean file scored {}", r.score);
        assert_eq!(r.structural, 1.0);
    }

    #[test]
    fn sentinels_dock_value_hygiene_including_fr() {
        // FR sentinel "inconnu" must count as junk (the unified-list win).
        let r = report("id,city\n1,Paris\n2,inconnu\n3,Lyon\n4,N/A\n");
        assert!(r.value_hygiene < 100.0, "sentinels ignored: {}", r.value_hygiene);
    }

    #[test]
    fn structural_gate_caps_a_wrong_delimiter_file() {
        // A ;-delimited file read as one column: every value splits into ~3
        // on ';' → shape_integrity ~1/3 → score capped low even though the
        // single column is "complete".
        let df = crate::parse::from_text("a;b;c\n1;2;3\n4;5;6\n7;8;9\n").unwrap();
        // sniff forces multi-col normally; simulate the under-parse by a
        // genuine 1-col frame of ;-joined rows:
        let one = DataFrame::new_infer_height(vec![Series::new(
            "rec".into(),
            &["1;2;3", "4;5;6", "7;8;9", "a;b;c"],
        )
        .into()])
        .unwrap();
        let cols = dtype::summarize(&one).unwrap();
        let r = cleanness_report(&one, &cols, &[]).unwrap();
        assert!(r.shape_integrity < 0.5, "shape gate didn't fire: {}", r.shape_integrity);
        let _ = df;
    }

    #[test]
    fn find_sentinels_buckets_by_casing() {
        let df = crate::parse::from_text("c\nN/A\nn/a\nAlice\n").unwrap();
        let occ = find_sentinels(&df, &[]);
        // "N/A" and "n/a" are separate values but share the canonical key.
        assert_eq!(occ.len(), 2);
        assert!(occ.iter().all(|o| o.canonical == "n/a"));
    }
}
