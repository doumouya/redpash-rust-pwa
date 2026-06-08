//! Doc: docs/internal/code/backend/data/dtype.md
//! Per-column type inference + light stats.
//!
//! Polars already infers a *storage* type when it parses the CSV — this
//! module coerces that into the frontend vocabulary (`int`, `float`,
//! `bool`, `date`, `string`, `empty`) **and** runs a `semantic_dtype`
//! sniff: for a column Polars had to store as `string` because its
//! cells are messy (`€995,83`, `Oui`/`non`, `12/03/2024`), we sample
//! ~50 non-null values and guess the *intended* dtype. The cleanness
//! scorer then docks columns where storage and semantic disagree,
//! proportional to how many cells fail a strict native parse.
//!
//! The cleaner sidebar uses `null_pct` + `unique_pct` to flag
//! low-quality columns and to suggest primary-key candidates. The
//! sample value powers the header tooltip ("first non-null:").

use crate::{DataError, Result};
use polars::prelude::*;
use shared::file::ColumnMeta;

pub fn summarize(df: &DataFrame) -> Result<Vec<ColumnMeta>> {
    let h = df.height().max(1) as f32;
    let mut out = Vec::with_capacity(df.width());

    for c in df.columns() {
        let nulls = c.null_count() as f32;
        let unique = c.n_unique().unwrap_or(0) as f32;

        let dtype = storage_dtype_name(c.dtype()).to_string();
        let semantic_dtype = sniff_semantic_type(c.as_materialized_series()).to_string();

        // First non-null cell — inlined so we don't need to name the
        // column type (its identifier varies across polars versions).
        let mut sample: Option<String> = None;
        for i in 0..c.len() {
            let v = c.get(i).map_err(DataError::from)?;
            if !matches!(v, AnyValue::Null) {
                sample = Some(match v {
                    AnyValue::String(s) => s.to_string(),
                    AnyValue::StringOwned(s) => s.to_string(),
                    other => other.to_string(),
                });
                break;
            }
        }

        out.push(ColumnMeta {
            name: c.name().to_string(),
            dtype,
            semantic_dtype,
            null_pct: Some(100.0 * nulls / h),
            unique_pct: Some(100.0 * unique / h),
            sample,
        });
    }

    Ok(out)
}

fn storage_dtype_name(d: &DataType) -> &'static str {
    match d {
        d if d.is_integer() => "int",
        d if d.is_float() => "float",
        DataType::Boolean => "bool",
        DataType::Date | DataType::Datetime(_, _) => "date",
        DataType::String => "string",
        DataType::Null => "empty",
        _ => "string",
    }
}

// Bool-ish tokens (FR + EN). Split into "any" (used for the count) and
// "non-numeric" (used as a guard so a pure `1/0` column lands as int,
// not bool).
const BOOL_WORDS_ANY: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f", "oui", "non", "vrai", "faux", "o", "0", "1",
];
const BOOL_WORDS_NON_NUMERIC: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f", "oui", "non", "vrai", "faux", "o",
];
const SENTINEL_TOKENS: &[&str] = &[
    "",
    "n/a",
    "na",
    "n.a.",
    "-",
    "--",
    "?",
    "null",
    "none",
    "nan",
    "#n/a",
    ".",
    "tbd",
    "x",
    "#ref!",
    "#value!",
    "unknown",
    "undefined",
    "nd",
];

/// Guess the column's *intended* type. When Polars already typed it
/// (int/float/bool/date), that *is* the semantic type. For
/// String-stored columns, sample ~50 non-null non-sentinel values and
/// score them against three lenient shape checks (bool / date / float).
/// `≥80%` agreement on a shape → that's the intent; otherwise it's a
/// genuine string column.
fn sniff_semantic_type(c: &Series) -> &'static str {
    match c.dtype() {
        d if d.is_integer() => return "int",
        d if d.is_float() => return "float",
        DataType::Boolean => return "bool",
        DataType::Date | DataType::Datetime(_, _) => return "date",
        DataType::Null => return "empty",
        DataType::String => {}
        _ => return "string",
    }

    // Sample up to 50 non-null, non-sentinel string cells.
    let mut samples: Vec<String> = Vec::with_capacity(50);
    for i in 0..c.len() {
        if samples.len() >= 50 {
            break;
        }
        let s = match c.get(i) {
            Ok(AnyValue::String(s)) => s.to_string(),
            Ok(AnyValue::StringOwned(s)) => s.to_string(),
            _ => continue,
        };
        let t = s.trim().to_ascii_lowercase();
        if t.is_empty() || SENTINEL_TOKENS.contains(&t.as_str()) {
            continue;
        }
        samples.push(t);
    }
    if samples.is_empty() {
        return "string";
    }
    let n = samples.len() as f32;

    // Bool — require ≥80% in the wordlist AND at least one non-numeric
    // token so a pure `1/0` column doesn't get tagged bool over int.
    let bool_hits = samples
        .iter()
        .filter(|s| BOOL_WORDS_ANY.contains(&s.as_str()))
        .count();
    let has_non_numeric_bool = samples
        .iter()
        .any(|s| BOOL_WORDS_NON_NUMERIC.contains(&s.as_str()));
    if has_non_numeric_bool && bool_hits as f32 / n >= 0.8 {
        return "bool";
    }
    // Date — three numeric groups separated by `/`-`-`-`.`, or an
    // 8-digit yyyymmdd.
    let date_hits = samples.iter().filter(|s| looks_date_shaped(s)).count();
    if date_hits as f32 / n >= 0.8 {
        return "date";
    }
    // Float — any cell with digits that's only digits + permitted dirt
    // chars (`,`, `.`, currency symbols, `%`, sign, whitespace, common
    // currency suffix letters). Polars couldn't natively type it; the
    // strict-parse score in stats.rs measures how many actually parse.
    let num_hits = samples.iter().filter(|s| looks_numeric_ish(s)).count();
    if num_hits as f32 / n >= 0.8 {
        // Guard against ID-shaped numerics — postal codes, badge ids,
        // phone numbers, sirens. Casting them to float strips meaning
        // (leading zero gone, identity changes). Two independent
        // signals — either trips the guard:
        //
        //   1. Column-name token matches a known id pattern
        //      (postal / postcode / zip / code / ref / id / ...).
        //      Word-split on non-alphanumerics so CODE_POSTAL,
        //      "code postal", code-postal all match.
        //   2. Any sample is a pure-digit string with a leading zero
        //      (length > 1) — e.g. "07920", "001234". Float cast
        //      drops the zero.
        let leading_zero = samples
            .iter()
            .any(|s| s.len() > 1 && s.starts_with('0') && s.chars().all(|c| c.is_ascii_digit()));
        if name_looks_id(c.name()) || leading_zero {
            return "string";
        }
        return "float";
    }
    "string"
}

/// Column-name tokens that strongly suggest an identifier / code (not
/// a measurement), even when the values look numeric. Used by
/// `sniff_semantic_type` to veto the float suggestion on things like
/// `CODE_POSTAL`, `siren`, `phone_number`. Kept tight on purpose —
/// `no` / `num` / `numero` were too eager (matched legitimate counts).
const ID_NAME_TOKENS: &[&str] = &[
    "postcode",
    "postal",
    "zip",
    "zipcode",
    "siren",
    "siret",
    "tva",
    "phone",
    "telephone",
    "mobile",
    "fax",
    "iban",
    "bic",
    "swift",
    "id",
    "uid",
    "guid",
    "uuid",
    "ssn",
    "code",
    "ref",
];

fn name_looks_id(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .any(|tok| ID_NAME_TOKENS.contains(&tok))
}

fn looks_date_shaped(s: &str) -> bool {
    // yyyymmdd (or yyyymmdd-ish 8-digit)
    if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // Three non-empty numeric groups split by a single consistent
    // `/`/`-`/`.` separator.
    for sep in ['/', '-', '.'] {
        let parts: Vec<&str> = s.split(sep).collect();
        if parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.len() <= 4 && p.chars().all(|c| c.is_ascii_digit()))
        {
            return true;
        }
    }
    false
}

// "Numeric-ish" — the cell *looks like* a number with some dirt.
// Must (a) start with a digit, sign, decimal point, or currency
// symbol, and (b) be ≥50% digits by character mass. (a) is what
// keeps a prefix-coded ID like `REN96584` or `CLI83991` from being
// mistaken for a number (its leading letters fail the first-char
// test). (b) catches the dirt the strict parse will later reject —
// `€995.83`, `1234,56`, `1654.54 HT`, `1000 EUR` — without needing a
// finicky letter whitelist for the trailing currency / unit suffix.
fn looks_numeric_ish(s: &str) -> bool {
    let total = s.chars().count();
    if total == 0 {
        return false;
    }
    let first = s.chars().next().unwrap();
    if !(first.is_ascii_digit() || matches!(first, '-' | '+' | '.' | '€' | '$' | '£')) {
        return false;
    }
    let digits = s.chars().filter(|c| c.is_ascii_digit()).count();
    digits > 0 && digits * 2 >= total
}

// ── type-drift detection (hook #6) ───────────────────────────────────
//
// The semantic sniff above only commits to a structured type at ≥80%
// agreement, so `type_consistency_score` can only dock columns that
// cleared that bar. A column that's *mostly* one type but contaminated
// — `[10, 20, foo, 40]` at 75% numeric — falls just under, is labelled
// a "genuine string column", and scores ≈100. That silent 50–95% band
// is the lie. `worst_type_drift` surfaces it for the structure penalty.

/// Coarse per-cell kind for drift detection — the same shape checks
/// `sniff_semantic_type` uses, applied at cell granularity. Blank /
/// sentinel cells are `Empty` (excluded from the drift denominator).
/// A bare `1`/`0` is `Numeric`, not `Bool` — matching the sniff's
/// int-over-bool guard (`BOOL_WORDS_NON_NUMERIC`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellKind {
    Empty,
    Numeric,
    Bool,
    Date,
    Text,
}

pub fn classify_cell(raw: &str) -> CellKind {
    let t = raw.trim();
    if t.is_empty() {
        return CellKind::Empty;
    }
    let low = t.to_ascii_lowercase();
    if SENTINEL_TOKENS.contains(&low.as_str()) {
        return CellKind::Empty;
    }
    if BOOL_WORDS_NON_NUMERIC.contains(&low.as_str()) {
        return CellKind::Bool;
    }
    if looks_date_shaped(&low) {
        return CellKind::Date;
    }
    if looks_numeric_ish(t) {
        return CellKind::Numeric;
    }
    CellKind::Text
}

/// Scan every String-stored column for **type drift** and return the
/// *worst* offender's `(name, off_type_fraction)`, or `None`.
///
/// A column drifts when its non-empty cells are *mostly* (≥50%) one
/// structured kind (numeric/bool/date) but *not pure* (<95%). Pure
/// columns are handled upstream (the sniff types them, the strict-parse
/// score docks the stragglers); mostly-text columns are genuine strings.
/// It's the in-between band that masquerades as clean. `off_fraction`
/// is `1 − dominant/total` ∈ (0.05, 0.5] — how contaminated the column
/// is — so the caller can scale the penalty by severity. Already-typed
/// columns (int/float/bool/date storage) are clean by construction and
/// skipped.
pub(crate) fn worst_type_drift(df: &DataFrame) -> Option<(String, f32)> {
    let mut worst: Option<(String, f32)> = None;
    for c in df.columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        let (mut num, mut boo, mut dat, mut total) = (0usize, 0usize, 0usize, 0usize);
        for i in 0..c.len() {
            let raw = match c.get(i) {
                Ok(AnyValue::String(s)) => s.to_string(),
                Ok(AnyValue::StringOwned(s)) => s.to_string(),
                _ => continue,
            };
            match classify_cell(&raw) {
                CellKind::Empty => continue,
                CellKind::Numeric => num += 1,
                CellKind::Bool => boo += 1,
                CellKind::Date => dat += 1,
                CellKind::Text => {}
            }
            total += 1;
        }
        if total < 4 {
            continue; // too few cells to judge a trend
        }
        let dominant = num.max(boo).max(dat);
        let frac = dominant as f32 / total as f32;
        if (0.5..0.95).contains(&frac) {
            let off = 1.0 - frac;
            if worst.as_ref().map_or(true, |(_, w)| off > *w) {
                worst = Some((c.name().to_string(), off));
            }
        }
    }
    worst
}

// ── date-format drift ────────────────────────────────────────────────
//
// A column can be 100% date-shaped (so the sniff types it `date` and no
// type-drift fires) yet mix incompatible FORMATS: `2026-01-13` + `13/01/2026`
// + `01/13/2026`. That's the most dangerous dirt in CSV land — `13/01` and
// `01/13` both "parse", to different days, silently. `worst_date_drift`
// surfaces a date column carrying ≥2 distinct format shapes, and flags the
// day/month *contradiction* (one cell forces dd/mm, another forces mm/dd).

/// The coarse format shape of a date-shaped cell, or `None` if not date-shaped.
/// Structural only (not a parse) — enough to tell "this column mixes formats".
/// `head` = year-first (yyyy-sep-x-sep-x), `tail` = year-last (x-sep-x-yyyy).
pub(crate) fn date_format_shape(s: &str) -> Option<&'static str> {
    let t = s.trim();
    if t.len() == 8 && t.bytes().all(|b| b.is_ascii_digit()) {
        return Some("compact8"); // yyyymmdd
    }
    for (sep, head, tail) in [
        ('-', "dash-head", "dash-tail"),
        ('/', "slash-head", "slash-tail"),
        ('.', "dot-head", "dot-tail"),
    ] {
        let p: Vec<&str> = t.split(sep).collect();
        if p.len() == 3
            && p.iter()
                .all(|g| !g.is_empty() && g.len() <= 4 && g.bytes().all(|b| b.is_ascii_digit()))
        {
            return Some(if p[0].len() == 4 { head } else { tail });
        }
    }
    None
}

/// For a year-last date (`x/x/yyyy`), which order does this cell *force*?
/// `Some(true)` = day-first (first group > 12, can only be a day),
/// `Some(false)` = month-first (second group > 12), `None` = ambiguous.
fn daymonth_force(s: &str) -> Option<bool> {
    let t = s.trim();
    for sep in ['/', '-', '.'] {
        let p: Vec<&str> = t.split(sep).collect();
        if p.len() == 3 && p[2].len() == 4 {
            let g0: u32 = p[0].parse().ok()?;
            let g1: u32 = p[1].parse().ok()?;
            if g0 > 12 && g1 <= 12 {
                return Some(true);
            } // dd/mm
            if g1 > 12 && g0 <= 12 {
                return Some(false);
            } // mm/dd
            return None;
        }
    }
    None
}

/// Scan String columns for date-format drift. Returns the worst date column's
/// `(name, distinct_shape_count, daymonth_contradiction)` or `None`. A column
/// qualifies when ≥80% of its non-empty cells are date-shaped (it's "a date
/// column") and it carries ≥2 distinct format shapes, OR a day/month
/// contradiction even within one shape.
pub(crate) fn worst_date_drift(df: &DataFrame) -> Option<(String, usize, bool)> {
    let mut worst: Option<(String, usize, bool)> = None;
    for c in df.columns() {
        if !matches!(c.dtype(), DataType::String) {
            continue;
        }
        let mut shapes = std::collections::HashSet::new();
        let (mut total, mut dated, mut dmy, mut mdy) = (0usize, 0usize, false, false);
        for i in 0..c.len() {
            let raw = match c.get(i) {
                Ok(AnyValue::String(s)) => s.to_string(),
                Ok(AnyValue::StringOwned(s)) => s.to_string(),
                _ => continue,
            };
            if raw.trim().is_empty() {
                continue;
            }
            total += 1;
            if let Some(shape) = date_format_shape(&raw) {
                dated += 1;
                shapes.insert(shape);
                match daymonth_force(&raw) {
                    Some(true) => dmy = true,
                    Some(false) => mdy = true,
                    None => {}
                }
            }
        }
        if total < 3 || dated * 5 < total * 4 {
            continue; // not a date column (≥80% date-shaped required)
        }
        let contradiction = dmy && mdy;
        if shapes.len() >= 2 || contradiction {
            let better = worst.as_ref().map_or(true, |(_, n, _)| shapes.len() > *n);
            if better {
                worst = Some((c.name().to_string(), shapes.len(), contradiction));
            }
        }
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df1(name: &str, vals: &[&str]) -> DataFrame {
        DataFrame::new_infer_height(vec![Series::new(name.into(), vals).into()]).unwrap()
    }

    #[test]
    fn classify_cell_kinds() {
        assert_eq!(classify_cell("42"), CellKind::Numeric);
        assert_eq!(classify_cell("1.234,56"), CellKind::Numeric); // dirty-numeric
        assert_eq!(classify_cell("yes"), CellKind::Bool);
        assert_eq!(classify_cell("N"), CellKind::Bool);
        assert_eq!(classify_cell("0"), CellKind::Numeric); // bare 0/1 is numeric, not bool
        assert_eq!(classify_cell("2024-01-15"), CellKind::Date);
        assert_eq!(classify_cell("foo"), CellKind::Text);
        assert_eq!(classify_cell("  "), CellKind::Empty);
        assert_eq!(classify_cell("N/A"), CellKind::Empty); // sentinel
    }

    #[test]
    fn drift_flags_contaminated_numeric_column() {
        // 3/4 numeric, one "foo" → 75% numeric, the silent band.
        let df = df1("amount", &["10", "20", "foo", "40"]);
        let (col, off) = worst_type_drift(&df).expect("should flag drift");
        assert_eq!(col, "amount");
        assert!((off - 0.25).abs() < 1e-6, "off fraction = {off}");
    }

    #[test]
    fn date_drift_flags_mixed_formats_and_contradiction() {
        // 3 shapes (dash-head, slash-tail, slash-head) + 13/01 vs 01/13 clash.
        let df = df1(
            "date",
            &[
                "2026-01-13",
                "13/01/2026",
                "01/13/2026",
                "2026/01/13",
                "2026-01-14",
            ],
        );
        let (col, shapes, contradiction) =
            worst_date_drift(&df).expect("mixed formats should drift");
        assert_eq!(col, "date");
        assert!(
            shapes >= 2 && contradiction,
            "shapes={shapes} contradiction={contradiction}"
        );
        // A clean single-format ISO column does NOT drift.
        let df = df1(
            "date",
            &["2026-01-13", "2026-01-14", "2026-02-01", "2026-03-09"],
        );
        assert!(
            worst_date_drift(&df).is_none(),
            "single-format dates are clean"
        );
    }

    #[test]
    fn drift_skips_clean_and_genuine_text() {
        // A genuine text column (all text) — no drift.
        let df = df1("city", &["Paris", "Rome", "Lyon", "Nice"]);
        assert!(worst_type_drift(&df).is_none());
        // A pure dirty-numeric String column (100% numeric-ish, e.g. all
        // `€`-prefixed) — handled by the sniff + strict-parse, not drift.
        let df = df1("price", &["€10", "€20", "€30", "€40"]);
        assert!(
            worst_type_drift(&df).is_none(),
            "pure numeric-ish is not drift"
        );
    }
}
