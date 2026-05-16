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

    for c in df.get_columns() {
        let nulls = c.null_count() as f32;
        let unique = c.n_unique().unwrap_or(0) as f32;

        let dtype = storage_dtype_name(c.dtype()).to_string();
        let semantic_dtype = sniff_semantic_type(c).to_string();

        // First non-null cell — inlined so we don't need to name the
        // column type (its identifier varies across polars versions).
        let mut sample: Option<String> = None;
        for i in 0..c.len() {
            let v = c.get(i).map_err(DataError::from)?;
            if !matches!(v, AnyValue::Null) {
                sample = Some(match v {
                    AnyValue::String(s)      => s.to_string(),
                    AnyValue::StringOwned(s) => s.to_string(),
                    other                    => other.to_string(),
                });
                break;
            }
        }

        out.push(ColumnMeta {
            name:       c.name().to_string(),
            dtype,
            semantic_dtype,
            null_pct:   Some(100.0 * nulls / h),
            unique_pct: Some(100.0 * unique / h),
            sample,
        });
    }

    Ok(out)
}

fn storage_dtype_name(d: &DataType) -> &'static str {
    match d {
        d if d.is_integer() => "int",
        d if d.is_float()   => "float",
        DataType::Boolean   => "bool",
        DataType::Date | DataType::Datetime(_, _) => "date",
        DataType::String    => "string",
        DataType::Null      => "empty",
        _                   => "string",
    }
}

// Bool-ish tokens (FR + EN). Split into "any" (used for the count) and
// "non-numeric" (used as a guard so a pure `1/0` column lands as int,
// not bool).
const BOOL_WORDS_ANY: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f",
    "oui", "non", "vrai", "faux", "o", "0", "1",
];
const BOOL_WORDS_NON_NUMERIC: &[&str] = &[
    "true", "false", "yes", "no", "y", "n", "t", "f",
    "oui", "non", "vrai", "faux", "o",
];
const SENTINEL_TOKENS: &[&str] = &[
    "", "n/a", "na", "n.a.", "-", "--", "?", "null", "none", "nan",
    "#n/a", ".", "tbd", "x", "#ref!", "#value!", "unknown", "undefined", "nd",
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
        d if d.is_float()   => return "float",
        DataType::Boolean   => return "bool",
        DataType::Date | DataType::Datetime(_, _) => return "date",
        DataType::Null      => return "empty",
        DataType::String    => {}
        _                   => return "string",
    }

    // Sample up to 50 non-null, non-sentinel string cells.
    let mut samples: Vec<String> = Vec::with_capacity(50);
    for i in 0..c.len() {
        if samples.len() >= 50 { break; }
        let s = match c.get(i) {
            Ok(AnyValue::String(s))      => s.to_string(),
            Ok(AnyValue::StringOwned(s)) => s.to_string(),
            _ => continue,
        };
        let t = s.trim().to_ascii_lowercase();
        if t.is_empty() || SENTINEL_TOKENS.contains(&t.as_str()) { continue; }
        samples.push(t);
    }
    if samples.is_empty() { return "string"; }
    let n = samples.len() as f32;

    // Bool — require ≥80% in the wordlist AND at least one non-numeric
    // token so a pure `1/0` column doesn't get tagged bool over int.
    let bool_hits = samples.iter().filter(|s| BOOL_WORDS_ANY.contains(&s.as_str())).count();
    let has_non_numeric_bool = samples.iter().any(|s| BOOL_WORDS_NON_NUMERIC.contains(&s.as_str()));
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
        let leading_zero = samples.iter().any(|s| {
            s.len() > 1 && s.starts_with('0') && s.chars().all(|c| c.is_ascii_digit())
        });
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
    "postcode", "postal", "zip", "zipcode",
    "siren", "siret", "tva",
    "phone", "telephone", "mobile", "fax",
    "iban", "bic", "swift",
    "id", "uid", "guid", "uuid", "ssn",
    "code", "ref",
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
            && parts.iter().all(|p| {
                !p.is_empty() && p.len() <= 4 && p.chars().all(|c| c.is_ascii_digit())
            })
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
    if total == 0 { return false; }
    let first = s.chars().next().unwrap();
    if !(first.is_ascii_digit() || matches!(first, '-' | '+' | '.' | '€' | '$' | '£')) {
        return false;
    }
    let digits = s.chars().filter(|c| c.is_ascii_digit()).count();
    digits > 0 && digits * 2 >= total
}
