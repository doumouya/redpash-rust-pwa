//! Purpose: per-column type inference — storage dtype (what Polars parsed) vs
//! SEMANTIC dtype (what the column intends to be), plus the type- and
//! date-format DRIFT detectors that surface the silent 50-95% "mostly one
//! type" band the strict score waves through.
//!
//! Ported faithfully (the calibration is the moat). Sentinel checks route
//! through the unified `crate::sentinels` (the predecessor's second list is
//! gone). FR-first: day-first/2-digit-year date shapes, FR+EN bool words.

use polars::prelude::*;
use shared::file::ColumnMeta;

use crate::{sentinels, DataError, Result};

pub fn summarize(df: &DataFrame) -> Result<Vec<ColumnMeta>> {
    let h = df.height().max(1) as f32;
    let mut out = Vec::with_capacity(df.width());
    for c in df.columns() {
        let nulls = c.null_count() as f32;
        let unique = c.n_unique().unwrap_or(0) as f32;
        let dtype = storage_dtype_name(c.dtype()).to_string();
        let semantic_dtype = sniff_semantic_type(c.as_materialized_series()).to_string();

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

const BOOL_WORDS_ANY: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f", "oui", "non", "vrai", "faux", "o", "0", "1",
];
const BOOL_WORDS_NON_NUMERIC: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f", "oui", "non", "vrai", "faux", "o",
];

/// Guess the column's intended type. Polars-typed columns ARE their type; for
/// string-stored columns, sample <=50 non-null non-sentinel cells and require
/// >=80% agreement on a shape (bool / date / float), with the ID-numeric veto.
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
        if sentinels::is_sentinel(&s) {
            continue;
        }
        samples.push(s.trim().to_ascii_lowercase());
    }
    if samples.is_empty() {
        return "string";
    }
    let n = samples.len() as f32;

    let bool_hits = samples.iter().filter(|s| BOOL_WORDS_ANY.contains(&s.as_str())).count();
    let has_non_numeric_bool =
        samples.iter().any(|s| BOOL_WORDS_NON_NUMERIC.contains(&s.as_str()));
    if has_non_numeric_bool && bool_hits as f32 / n >= 0.8 {
        return "bool";
    }
    let date_hits = samples.iter().filter(|s| looks_date_shaped(s)).count();
    if date_hits as f32 / n >= 0.8 {
        return "date";
    }
    let num_hits = samples.iter().filter(|s| looks_numeric_ish(s)).count();
    if num_hits as f32 / n >= 0.8 {
        // Veto float on ID-shaped numerics — a leading-zero string or an
        // id-ish column name means casting strips meaning.
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

const ID_NAME_TOKENS: &[&str] = &[
    "postcode", "postal", "zip", "zipcode", "siren", "siret", "tva", "phone", "telephone",
    "mobile", "fax", "iban", "bic", "swift", "id", "uid", "guid", "uuid", "ssn", "code", "ref",
];

fn name_looks_id(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .any(|tok| ID_NAME_TOKENS.contains(&tok))
}

fn looks_date_shaped(s: &str) -> bool {
    if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
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

/// "Numeric-ish": starts with a digit/sign/decimal/currency AND is >=50%
/// digits by mass — catches dirty numbers (€995,83 / 1234,56 / 1000 EUR)
/// while a prefix-coded id (REN96584) fails the first-char test.
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

// ── type-drift (the silent 50-95% band) ──────────────────────────────────

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
    if t.is_empty() || sentinels::is_sentinel(t) {
        return CellKind::Empty;
    }
    let low = t.to_ascii_lowercase();
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

/// Worst string column whose non-empty cells are MOSTLY (>=50%) one structured
/// kind but NOT pure (<95%) — the band that masquerades as clean. Returns
/// `(name, off_fraction)`. Consumed by the `structure` raw-bytes suspicion
/// pass (next engine slice), which is why it is unused for the moment.
#[allow(dead_code)]
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
            continue;
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

// ── date-format drift (mixed dd/mm vs mm/dd is the most dangerous dirt) ────

#[allow(dead_code)]
pub(crate) fn date_format_shape(s: &str) -> Option<&'static str> {
    let t = s.trim();
    if t.len() == 8 && t.bytes().all(|b| b.is_ascii_digit()) {
        return Some("compact8");
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

fn daymonth_force(s: &str) -> Option<bool> {
    let t = s.trim();
    for sep in ['/', '-', '.'] {
        let p: Vec<&str> = t.split(sep).collect();
        if p.len() == 3 && p[2].len() == 4 {
            let g0: u32 = p[0].parse().ok()?;
            let g1: u32 = p[1].parse().ok()?;
            if g0 > 12 && g1 <= 12 {
                return Some(true);
            }
            if g1 > 12 && g0 <= 12 {
                return Some(false);
            }
            return None;
        }
    }
    None
}

#[allow(dead_code)]
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
            continue;
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
        assert_eq!(classify_cell("1.234,56"), CellKind::Numeric);
        assert_eq!(classify_cell("yes"), CellKind::Bool);
        assert_eq!(classify_cell("0"), CellKind::Numeric); // bare 0/1 is numeric
        assert_eq!(classify_cell("2024-01-15"), CellKind::Date);
        assert_eq!(classify_cell("foo"), CellKind::Text);
        assert_eq!(classify_cell("N/A"), CellKind::Empty); // unified sentinel
        assert_eq!(classify_cell("inconnu"), CellKind::Empty); // FR sentinel (was the drift)
    }

    #[test]
    fn semantic_sniff_vetoes_id_numerics() {
        // leading-zero postal codes stay string, not float
        let df = df1("code_postal", &["07920", "01000", "13001", "75008"]);
        assert_eq!(sniff_semantic_type(df.columns()[0].as_materialized_series()), "string");
        // clean prices sniff float
        let df = df1("prix", &["10.5", "20.0", "33.9", "8.25"]);
        assert_eq!(sniff_semantic_type(df.columns()[0].as_materialized_series()), "float");
    }

    #[test]
    fn drift_flags_contaminated_numeric_column() {
        let df = df1("amount", &["10", "20", "foo", "40"]);
        let (col, off) = worst_type_drift(&df).expect("should flag drift");
        assert_eq!(col, "amount");
        assert!((off - 0.25).abs() < 1e-6);
    }

    #[test]
    fn date_drift_flags_mixed_formats_and_contradiction() {
        let df = df1("date", &["2026-01-13", "13/01/2026", "01/13/2026", "2026/01/13", "2026-01-14"]);
        let (col, shapes, contradiction) = worst_date_drift(&df).expect("mixed formats drift");
        assert_eq!(col, "date");
        assert!(shapes >= 2 && contradiction);
        let clean = df1("date", &["2026-01-13", "2026-01-14", "2026-02-01", "2026-03-09"]);
        assert!(worst_date_drift(&clean).is_none());
    }
}
