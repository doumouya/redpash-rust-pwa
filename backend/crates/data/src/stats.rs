//! Doc: docs/internal/code/backend/data/stats.md
//! Column statistics + the file-level **cleanness score**.
//!
//! `unique_values` iterates a single column, collects up to ~3× the
//! requested cap into a HashSet (to keep the result diverse when the
//! column is huge), then sorts and truncates. Output is alphabetical
//! ASCII order; the frontend renders as a `<datalist>`.

use crate::{DataError, Result};
use polars::prelude::*;
use shared::file::ColumnMeta;
use std::collections::{HashMap, HashSet};

/// Values that are "filled" but carry no information — they're not
/// nulls (so the completeness component never sees them) and they're
/// not real data either. Matched case-insensitively. Exposed so the
/// `find_sentinels` scan (and any UI that wants the canonical list)
/// can reuse it without redefining.
pub const SENTINELS: &[&str] = &[
    "n/a", "na", "n.a.", "-", "--", "?", "null", "none", "nan",
    "#n/a", ".", "tbd", "x", "#ref!", "#value!", "unknown", "undefined",
];

/// One sentinel value discovered across the frame, with per-column
/// counts. `value` keeps the cell's *original* casing / whitespace
/// (so the UI shows what the user actually has on disk) while
/// `canonical` is the lowercased-trimmed key used to bucket variants
/// like `"N/A"` / `"n/a"` / `" N/A "` together.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SentinelOccurrence {
    pub value:     String,
    pub canonical: String,
    pub total:     u64,
    /// `(column_name, count)` pairs, sorted by count desc.
    pub columns:   Vec<(String, u64)>,
}

/// Scan every string column for cells whose trimmed-lowercased form
/// matches one of `SENTINELS` **or one of `extras`** (the user's
/// learned set + any ad-hoc values typed into the modal). Returns
/// one entry per *distinct sentinel as it appears in the file*
/// (`"N/A"` and `"n/a"` are reported separately so the UI can
/// preserve casing). Sorted by total count desc, then by value asc
/// for stability. Empty when the frame has no string columns or no
/// matches were found.
///
/// The `extras` list is **user data** — typos and noise get in.
/// We canonicalise each entry (trim + lowercase) and skip empties
/// before matching; the original casing only matters for the
/// per-user prefs round-trip the frontend does.
pub fn find_sentinels(df: &DataFrame, extras: &[String]) -> Vec<SentinelOccurrence> {
    // Union of the canonical sentinel list + the caller's extras. The
    // `HashSet<&str>` here borrows from `extras_lower`, which has to
    // outlive the scan loop — hence the explicit owned vec above it.
    let extras_lower: Vec<String> = extras.iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let mut canonical: HashSet<&str> = SENTINELS.iter().copied().collect();
    for e in &extras_lower { canonical.insert(e.as_str()); }

    // (value_as_found) → (canonical, total, per-column counts)
    let mut buckets: HashMap<String, (String, u64, HashMap<String, u64>)> = HashMap::new();
    for series in df.get_columns() {
        if !matches!(series.dtype(), DataType::String) { continue; }
        let cname = series.name().to_string();
        for i in 0..series.len() {
            let av = match series.get(i) { Ok(v) => v, Err(_) => continue };
            let raw: String = match av {
                AnyValue::String(s)      => s.to_string(),
                AnyValue::StringOwned(s) => s.to_string(),
                _                        => continue,
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() { continue; }
            let canon = trimmed.to_ascii_lowercase();
            if !canonical.contains(canon.as_str()) { continue; }
            let entry = buckets.entry(raw.clone())
                .or_insert_with(|| (canon, 0u64, HashMap::new()));
            entry.1 += 1;
            *entry.2.entry(cname.clone()).or_insert(0u64) += 1;
        }
    }
    let mut out: Vec<SentinelOccurrence> = buckets.into_iter()
        .map(|(value, (canonical, total, cols_map))| {
            // Stable per-column ordering: by count desc, then name asc.
            let mut cols: Vec<(String, u64)> = cols_map.into_iter().collect();
            cols.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            SentinelOccurrence { value, canonical, total, columns: cols }
        })
        .collect();
    out.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.value.cmp(&b.value)));
    out
}

/// Full per-file breakdown — every sub-score that feeds into the
/// blended `score`. Returned by `cleanness_report`; the upload path
/// just uses `cleanness().score` for persistence, but the eval harness
/// (`examples/score_dir.rs`) and any future "why is this 86?" UI can
/// surface each component to point the user at what to fix.
#[derive(Debug, Clone, Copy)]
pub struct CleannessReport {
    /// Blended final score, 0..100. `value_quality * structural`.
    pub score:              f32,
    // ── value-quality components, 0..100 each (weights in cleanness) ──
    /// `100 − mean(null_pct)`. Weight 35%.
    pub completeness:       f32,
    /// Strict-parse pass rate against each column's `semantic_dtype`. Weight 25%.
    pub type_consistency:   f32,
    /// Fraction of string cells with no whitespace pad / no sentinel value. Weight 25%.
    pub value_hygiene:      f32,
    /// `100 × distinct_rows / total_rows`. Weight 15%.
    pub row_uniqueness:     f32,
    /// Pre-clamp weighted blend of the four above, 0..100.
    pub value_quality:      f32,
    // ── structural-tier sub-signals, 0..1 each (min taken as gate) ───
    /// `1/m` if the lone column is m-fields-per-cell under-parsed, else 1.0.
    pub shape_integrity:    f32,
    /// Fraction of string cells free of U+FFFD or `Ã©`-style mojibake.
    pub encoding_integrity: f32,
    /// 0.5 if the lone column's name is a `sep` / `#…` / `Key: value` artefact.
    pub header_integrity:   f32,
    /// `min` of the three structural sub-signals — the gate.
    pub structural:         f32,
}

/// File-level cleanness score (0–100).
///
/// Two tiers:
///   • **structural integrity** ∈ [0,1] — did the file even parse into
///     a sane shape? Catches the doubly-CSV-encoded export that lands
///     as one giant quoted column, and mojibake from a wrong encoding.
///   • **value quality** ∈ [0,100] — given a sane shape, how clean are
///     the values? A weighted blend of four components.
///
///   `score = value_quality × structural_integrity`
///
/// Structure is a *gate*, not a fifth averaged component: a file that
/// parsed into one bogus column is 0% usable no matter how "complete"
/// that column looks, so it has to cap the ceiling rather than dilute
/// into an average. `structural_integrity` is the *weakest link* (min)
/// of three sub-signals — `shape`, `encoding`, `header`.
///
/// Returns `None` for an empty frame (no columns or no rows) — nothing
/// to score, and the DB column is nullable so `None` round-trips.
pub fn cleanness(df: &DataFrame, columns: &[ColumnMeta], extras: &[String]) -> Option<f32> {
    cleanness_report(df, columns, extras).map(|r| r.score)
}

/// Full breakdown — same gate × value-quality math as `cleanness`, but
/// returns every sub-score so diagnostic surfaces (the eval harness,
/// the cleaner sidebar's "why is this low?" view, …) can point at the
/// specific component that's pulling the file down.
/// `extras` extends the canonical `SENTINELS` vocabulary that
/// `value_hygiene_score` matches against — typically the union of
/// the caller's `prefs.learned_sentinels` and the `global_sentinels`
/// view (≥2-user submissions). An empty slice reproduces the
/// pre-learning baseline byte-for-byte.
pub fn cleanness_report(df: &DataFrame, columns: &[ColumnMeta], extras: &[String]) -> Option<CleannessReport> {
    if df.width() == 0 || df.height() == 0 || columns.is_empty() {
        return None;
    }

    // ── value quality — four components, each 0..100 ───────────────
    let completeness     = completeness_score(columns);
    let type_consistency = type_consistency_score(df, columns);
    let value_hygiene    = value_hygiene_score(df, extras);
    let row_uniqueness   = row_uniqueness_score(df);
    let value_quality = 0.35 * completeness
                      + 0.25 * type_consistency
                      + 0.25 * value_hygiene
                      + 0.15 * row_uniqueness;

    // ── structural integrity — 0..1 gate, weakest link ────────────
    let shape    = shape_integrity(df);
    let encoding = encoding_integrity(df);
    let header   = header_integrity(df);
    let structural = shape.min(encoding).min(header);

    Some(CleannessReport {
        score: (value_quality * structural).clamp(0.0, 100.0),
        completeness, type_consistency, value_hygiene, row_uniqueness,
        value_quality,
        shape_integrity: shape,
        encoding_integrity: encoding,
        header_integrity: header,
        structural,
    })
}

/// **Completeness** — `100 − null_pct` per column, averaged. An
/// all-null (`"empty"` dtype) column is pinned to 0.
fn completeness_score(columns: &[ColumnMeta]) -> f32 {
    let sum: f32 = columns.iter().map(|c| {
        if c.dtype == "empty" {
            0.0
        } else {
            (100.0 - c.null_pct.unwrap_or(0.0).clamp(0.0, 100.0)).clamp(0.0, 100.0)
        }
    }).sum();
    sum / columns.len() as f32
}

/// **Type consistency** — per column, how cleanly its cells parse as
/// the *intended* type (`ColumnMeta::semantic_dtype`, sniffed by
/// `dtype::summarize`). When storage and semantic agree (already-typed
/// columns, genuine string columns), the column scores 100. When they
/// diverge — a `string`-stored column whose values are *trying* to be
/// `float` / `date` / `bool` / `int` — the score is the fraction of
/// non-null non-empty cells that pass a strict native parse for the
/// intent. A `prix_ht` column of clean numbers scores 100; one peppered
/// with `€995,83` and `1 234,56 EUR` scores proportionally low. The
/// non-null denominator keeps this orthogonal to `completeness_score`.
fn type_consistency_score(df: &DataFrame, columns: &[ColumnMeta]) -> f32 {
    if columns.is_empty() { return 100.0; }
    let mut sum = 0.0f32;
    for cm in columns {
        let storage = cm.dtype.as_str();
        let intent  = cm.semantic_dtype.as_str();
        // Polars typed it OK, or it's genuinely a text column — nothing
        // for type-consistency to dock.
        if storage != "string" || intent == "string" || intent == "empty" {
            sum += 100.0;
            continue;
        }
        // Storage / semantic disagree: count non-null non-empty cells
        // that natively parse as the intended type.
        let Ok(c) = df.column(&cm.name) else { sum += 100.0; continue; };
        let (mut total, mut clean) = (0u64, 0u64);
        for i in 0..c.len() {
            let Some(raw) = cell_str(c, i) else { continue };
            let t = raw.trim();
            if t.is_empty() { continue; }
            total += 1;
            let ok = match intent {
                "float" | "int" => is_clean_numeric(t),
                "date"          => is_clean_iso_date(t),
                "bool"          => is_clean_bool(t),
                _               => true,
            };
            if ok { clean += 1; }
        }
        sum += if total == 0 { 100.0 } else { 100.0 * clean as f32 / total as f32 };
    }
    sum / columns.len() as f32
}

/// Strict numeric parse — matches what Polars would natively type as a
/// float (Rust's `f64::parse` is the same parser). `€995.83` /
/// `1234,56` / `1 234.56` all fail; `1234`, `-12.34`, `1.5e10` pass.
fn is_clean_numeric(s: &str) -> bool {
    s.parse::<f64>().is_ok()
}

/// Strict ISO date — `yyyy-mm-dd` with `mm`/`dd` allowed to be 1 or 2
/// digits. Any other format (slashes, dots, `dd/mm/yyyy`, …) is dirty.
fn is_clean_iso_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4 && parts[0].chars().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[1].len()) && parts[1].chars().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[2].len()) && parts[2].chars().all(|c| c.is_ascii_digit())
}

/// Strict boolean — exact `true` / `false` (case-insensitive). Any
/// French / coded variant (`Oui`, `O`, `1`, …) is dirty.
fn is_clean_bool(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "true" | "false")
}

/// **Value hygiene** — fraction of string cells that aren't
/// whitespace-padded and aren't a sentinel (`N/A`, `-`, `?`, …).
/// Sentinels matter because they're "filled" — completeness misses
/// them entirely. Genuinely empty / whitespace-only cells are skipped
/// (that's completeness's concern). 100 when there are no string cells.
///
/// `extras` extends the canonical `SENTINELS` list with caller-supplied
/// values (typically `prefs.learned_sentinels` ∪ `global_sentinels`).
/// Each extra is canonicalised (trim + lowercase) before matching;
/// passing `&[]` reproduces the pre-learning behaviour exactly.
fn value_hygiene_score(df: &DataFrame, extras: &[String]) -> f32 {
    // Build the per-call canonical vocabulary. `HashSet<&str>` borrows
    // from `extras_lower`, so the owned vec has to outlive the loop.
    let extras_lower: Vec<String> = extras.iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let mut sentinels: HashSet<&str> = SENTINELS.iter().copied().collect();
    for e in &extras_lower { sentinels.insert(e.as_str()); }

    let (mut total, mut clean) = (0u64, 0u64);
    for c in df.get_columns() {
        if !matches!(c.dtype(), DataType::String) { continue; }
        for i in 0..c.len() {
            let Some(raw) = cell_str(c, i) else { continue };
            let trimmed = raw.trim();
            if trimmed.is_empty() { continue; } // null-ish — not hygiene's job
            total += 1;
            let padded     = raw.len() != trimmed.len();
            let is_sentinel = sentinels.contains(trimmed.to_ascii_lowercase().as_str());
            if !padded && !is_sentinel { clean += 1; }
        }
    }
    if total == 0 { 100.0 } else { 100.0 * clean as f32 / total as f32 }
}

/// **Row uniqueness** — `100 × distinct_rows / total_rows`. Exact
/// full-row duplicates are the `drop_duplicates` step's target.
fn row_uniqueness_score(df: &DataFrame) -> f32 {
    let rows = df.height();
    if rows == 0 { return 100.0; }
    let cols = df.get_columns();
    let mut seen: HashSet<Vec<Option<String>>> = HashSet::with_capacity(rows);
    for i in 0..rows {
        let key: Vec<Option<String>> = cols.iter()
            .map(|c| c.get(i).ok().and_then(av_to_owned))
            .collect();
        seen.insert(key);
    }
    100.0 * seen.len() as f32 / rows as f32
}

/// **Parse-shape integrity** ∈ [0,1] — a single-column frame is
/// intrinsically suspect: real datasets almost never have exactly one
/// column. When that lone column's values *consistently* split into
/// m≥2 fields on a delimiter, the file was under-parsed — a wrong
/// delimiter (a `;`-file read as `,`), or a doubly-CSV-encoded export
/// that landed as one giant quoted column. Integrity is `1/m` (the
/// file should have had ~m columns). The "consistently" guard — ≥80%
/// of values share one modal field count — is what keeps a genuine
/// one-column free-text file (where comma counts vary wildly) from
/// tripping it. Multi-column frames parsed fine → 1.0.
fn shape_integrity(df: &DataFrame) -> f32 {
    if df.width() != 1 {
        return 1.0;
    }
    let Some(c) = df.get_columns().first() else { return 1.0 };
    if !matches!(c.dtype(), DataType::String) {
        return 1.0;
    }
    const DELIMS: [char; 4] = [',', ';', '\t', '|'];
    let mut worst = 1.0f32;
    for d in DELIMS {
        // Sample ~300 values; tally how many fields each splits into.
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

/// **Header integrity** ∈ [0,1] — only meaningful for a single-column
/// frame (a multi-column frame parsed fine; don't second-guess its
/// headers). A lone column whose *name* is a junk / preamble artifact —
/// an Excel `sep=` hint, a `#`-comment line, a `Key: value` metadata
/// line, or blank — means the parser latched onto a preamble row
/// instead of the real header. 0.5 (a clearly-suspect parse), else 1.0.
fn header_integrity(df: &DataFrame) -> f32 {
    if df.width() != 1 {
        return 1.0;
    }
    let Some(c) = df.get_columns().first() else { return 1.0 };
    let name = c.name().trim();
    let lower = name.to_ascii_lowercase();
    let junk = name.is_empty()
        || lower == "sep"
        || lower.starts_with("sep=")
        || name.starts_with('#')
        || name.contains(": "); // "Domaine: clients" — a preamble line, not a header
    if junk { 0.5 } else { 1.0 }
}

// High-frequency French double-decode mojibake signatures — what you
// get when a UTF-8 file is read as latin-1 (or vice versa). Each is a
// two-byte sequence starting with `Ã` followed by the second byte of
// the original UTF-8 character: `Ã©` was `é`, `Ã¨` was `è`, etc. These
// are valid UTF-8 themselves, so a wrong-encoding decode produces text
// that looks intact but is garbage. Listed roughly in frequency order
// for French; `Ã©` alone catches >50% of real-world cases.
const MOJIBAKE_SIGS: &[&str] = &[
    "Ã©", "Ã¨", "Ãª", "Ã ", "Ã§", "Ã®", "Ã´", "Ã¢", "Ã¹", "Ã»",
];

/// **Encoding integrity** ∈ [0,1] — fraction of string cells with no
/// encoding damage. Catches both flavours: **U+FFFD** replacement
/// chars (the parser couldn't decode some bytes) and **`Ã©`-style
/// double-decode** mojibake (the parser decoded successfully but with
/// the wrong codec — common when a latin-1 file is read as UTF-8). A
/// cell hitting either signal counts as damaged once.
fn encoding_integrity(df: &DataFrame) -> f32 {
    let (mut total, mut damaged) = (0u64, 0u64);
    for c in df.get_columns() {
        if !matches!(c.dtype(), DataType::String) { continue; }
        for i in 0..c.len() {
            let Some(v) = cell_str(c, i) else { continue };
            total += 1;
            if v.contains('\u{FFFD}')
                || MOJIBAKE_SIGS.iter().any(|s| v.contains(s))
            {
                damaged += 1;
            }
        }
    }
    if total == 0 { 1.0 } else { 1.0 - damaged as f32 / total as f32 }
}

/// One cell as an owned `String` — `None` for null / non-string cells.
fn cell_str(c: &Series, i: usize) -> Option<String> {
    match c.get(i) {
        Ok(AnyValue::String(s))      => Some(s.to_string()),
        Ok(AnyValue::StringOwned(s)) => Some(s.to_string()),
        _ => None,
    }
}

/// Count cells that differ between `before` and `after`. Compares every
/// column that exists in both frames, stringifying values so dtype
/// changes (e.g. fill_null replacing nulls with a literal "Unknown")
/// still count as a change.
///
/// Only valid when both frames have the same row count — the caller
/// gates this on `rows_before == rows_after`.
pub fn count_cell_diffs(before: &DataFrame, after: &DataFrame) -> u64 {
    let n = before.height().min(after.height());
    let after_names: HashSet<String> = after.get_columns().iter()
        .map(|c| c.name().to_string()).collect();
    let common: Vec<String> = before.get_columns().iter()
        .map(|c| c.name().to_string())
        .filter(|n| after_names.contains(n))
        .collect();

    let mut changed = 0u64;
    for cname in &common {
        let (Ok(bc), Ok(ac)) = (before.column(cname), after.column(cname)) else { continue; };
        for i in 0..n {
            let bs = bc.get(i).ok().and_then(av_to_owned);
            let as_ = ac.get(i).ok().and_then(av_to_owned);
            if bs != as_ { changed += 1; }
        }
    }
    changed
}

fn av_to_owned(v: AnyValue) -> Option<String> {
    match v {
        AnyValue::Null            => None,
        AnyValue::String(s)       => Some(s.to_string()),
        AnyValue::StringOwned(s)  => Some(s.to_string()),
        other                     => Some(other.to_string()),
    }
}

/// Count rows where *every* column is null. Cross-column — can't be
/// derived from per-column null_pct (a column with 50% nulls and
/// another with 50% nulls might have zero rows where both are null).
/// Drives the Drop-nulls form's context surface so the user can see
/// the obvious-junk count before picking a strategy.
///
/// Width-0 / height-0 frames return 0. O(rows × cols), pure scan.
pub fn count_fully_null_rows(df: &DataFrame) -> u64 {
    let n = df.height();
    if n == 0 || df.width() == 0 { return 0; }
    let cols = df.get_columns();
    let mut count = 0u64;
    for i in 0..n {
        let mut all_null = true;
        for c in cols {
            if !matches!(c.get(i), Ok(AnyValue::Null)) {
                all_null = false;
                break;
            }
        }
        if all_null { count += 1; }
    }
    count
}

/// Up to `limit` distinct non-null values from `col`, sorted.
pub fn unique_values(df: &DataFrame, col: &str, limit: usize) -> Result<Vec<String>> {
    let column = df.column(col).map_err(DataError::from)?;
    let scan_cap = limit.saturating_mul(3).max(limit);
    let mut set: HashSet<String> = HashSet::new();
    for i in 0..column.len() {
        if set.len() >= scan_cap { break; }
        let v = column.get(i).map_err(DataError::from)?;
        let s = match v {
            AnyValue::Null            => continue,
            AnyValue::String(s)       => (*s).to_string(),
            AnyValue::StringOwned(s)  => s.to_string(),
            other                     => other.to_string(),
        };
        if !s.is_empty() { set.insert(s); }
    }
    let mut vec: Vec<String> = set.into_iter().collect();
    vec.sort();
    vec.truncate(limit);
    Ok(vec)
}
