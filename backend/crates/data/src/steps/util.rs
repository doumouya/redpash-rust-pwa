//! Doc: docs/internal/code/backend/data/steps/util.md
//! Step-engine helpers: JSON-arg extraction, column-keep projection,
//! filter-predicate compilation, date / snake-case utilities.
//!
//! Split out of `steps/mod.rs` so the cleaning-step dispatcher there can
//! stay focused on the per-kind match. All helpers are `pub(super)` —
//! consumed only by the dispatcher, never by external callers.

use crate::{DataError, Result};
use polars::prelude::*;

pub(super) fn arr_strings(params: &serde_json::Value, key: &str) -> Vec<String> {
    params.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

pub(super) fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null      => String::new(),
        other                        => other.to_string(),
    }
}

pub(super) fn select_keep(df: DataFrame, keep: &[String]) -> Result<DataFrame> {
    let refs: Vec<&str> = keep.iter().map(|s| s.as_str()).collect();
    df.select(refs).map_err(DataError::from)
}

/// Build a single Polars `Expr` for one filter_rows predicate.
///
/// Numeric ops cast the value side to Float64 so the comparison works
/// across Int64 / Float64 columns without per-row dtype branching;
/// Polars widens the column side automatically for the comparison.
///
/// String ops cast the COLUMN side to String — guards against the
/// column having drifted to Categorical / Utf8View after a previous
/// step.
///
/// Date ops cast the value to Date (lazy parse via Polars' default
/// strptime). If the value can't be parsed at runtime the filter
/// drops every row (Polars `lit(value).cast(Date)` returns NULL),
/// which is the right behavior — a bogus date filter shouldn't
/// silently keep all rows.
pub(super) fn build_filter_predicate(
    column: &str,
    op: &str,
    value: Option<&serde_json::Value>,
    case_sensitive: bool,
) -> Result<Expr> {
    let c = col(column);
    let need_value = || -> Result<&serde_json::Value> {
        value.ok_or_else(|| DataError::InvalidSpec(
            format!("filter_rows op `{op}` needs a value")))
    };
    let val_string = || -> Result<String> { Ok(json_to_string(need_value()?)) };
    let val_f64    = || -> Result<f64> {
        let v = need_value()?;
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .ok_or_else(|| DataError::InvalidSpec(
                format!("filter_rows op `{op}` needs a numeric value")))
    };
    let val_array  = || -> Result<Vec<String>> {
        let v = need_value()?;
        v.as_array()
            .map(|a| a.iter().map(json_to_string).collect())
            .ok_or_else(|| DataError::InvalidSpec(
                format!("filter_rows op `{op}` needs an array value")))
    };

    Ok(match op {
        "eq"  => c.cast(DataType::String).eq(lit(val_string()?)),
        "neq" => c.cast(DataType::String).neq(lit(val_string()?)),

        "in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(false)   // empty set → nothing matches
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter()
                    .map(|v| s.clone().eq(lit(v)))
                    .reduce(|a, b| a.or(b))
                    .unwrap()
            }
        }
        "not_in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(true)    // empty exclusion → everything matches
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter()
                    .map(|v| s.clone().neq(lit(v)))
                    .reduce(|a, b| a.and(b))
                    .unwrap()
            }
        }

        "contains" => {
            let pat = val_string()?;
            // case_sensitive=false → lowercase both sides. Simpler than
            // the str.contains literal=false branch, and works for the
            // Utf8View string type Polars uses internally.
            if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase()
                    .str().contains_literal(lit(pat.to_lowercase()))
            }
        }
        // Symmetric inverse of `contains` — same case-sensitivity
        // semantics, negated predicate. Reconciles the long-standing
        // shared::FilterOp::NotContains variant the UI could already
        // emit (the engine previously returned InvalidSpec for it).
        "not_contains" => {
            let pat = val_string()?;
            let inner = if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase()
                    .str().contains_literal(lit(pat.to_lowercase()))
            };
            inner.not()
        }
        "starts_with" => c.cast(DataType::String).str().starts_with(lit(val_string()?)),
        "ends_with"   => c.cast(DataType::String).str().ends_with(lit(val_string()?)),

        // Numeric comparisons. Cast the value to Float64; Polars widens
        // the column side as needed.
        "gt"  => c.gt (lit(val_f64()?)),
        "gte" => c.gt_eq(lit(val_f64()?)),
        "lt"  => c.lt (lit(val_f64()?)),
        "lte" => c.lt_eq(lit(val_f64()?)),

        "between" => {
            // value must be a 2-element array [low, high], inclusive.
            let arr = need_value()?.as_array().ok_or_else(|| DataError::InvalidSpec(
                "filter_rows op `between` needs value: [low, high]".into()))?;
            if arr.len() != 2 {
                return Err(DataError::InvalidSpec(
                    "filter_rows op `between` needs exactly two endpoints".into()));
            }
            let parse = |v: &serde_json::Value| -> Result<f64> {
                v.as_f64()
                    .or_else(|| v.as_i64().map(|n| n as f64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .ok_or_else(|| DataError::InvalidSpec(
                        "filter_rows op `between` endpoints must be numeric".into()))
            };
            let lo = parse(&arr[0])?;
            let hi = parse(&arr[1])?;
            c.clone().gt_eq(lit(lo)).and(c.lt_eq(lit(hi)))
        }

        // Date ops — value side parsed by Polars lazily. Bogus date
        // strings cast to NULL and the comparison fails for every row,
        // which is the right behavior (loud failure beats silent keep).
        "before" => c.cast(DataType::Date)
                     .lt(lit(val_string()?).cast(DataType::Date)),
        "after"  => c.cast(DataType::Date)
                     .gt(lit(val_string()?).cast(DataType::Date)),

        "is_null"  => c.is_null(),
        "not_null" => c.is_not_null(),

        other => return Err(DataError::InvalidSpec(
            format!("unsupported filter_rows op: {other}"))),
    })
}

pub(super) fn default_strptime() -> StrptimeOptions {
    StrptimeOptions { format: None, strict: false, exact: false, cache: true }
}

/// Try several common date layouts and take the first that parses.
/// Polars' default `cast(Date)` only accepts ISO `YYYY-MM-DD`, so
/// strings like `2021/02/16` or `16/02/2021` would otherwise become null.
pub(super) fn parse_date_flex(column: &str) -> Expr {
    // Order matters — `coalesce` takes the first format that parses, so
    // less-ambiguous shapes come first and DAY-FIRST precedes month-first
    // (RedPash's FR + Africa-first market default; a true mm/dd file with
    // all days ≤12 is the rare loss). 2-digit years (`%y`: 00-68→20xx,
    // 69-99→19xx) handle `02/01/23` — the dominant clean-score date shape.
    const FORMATS: &[&str] = &[
        // 2-digit-year cases come FIRST. `%Y` is greedy — it matches "02"
        // in `02/01/23` as year 0002 — so the 2-digit `%y` formats MUST be
        // tried before any `%Y` format or dd/mm/yy dates parse to year 2.
        // `exact: true` makes a real 4-digit year fail the `%y` formats (it
        // leaves 2 unconsumed digits), so ordering 2-digit-first is safe.
        "%d/%m/%y", "%d-%m-%y", "%d.%m.%y",   // 2-digit, day-first (FR/Africa default)
        "%m/%d/%y",                            // 2-digit, month-first (US)
        // 4-digit year, day-first then month-first
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",
        "%m/%d/%Y", "%m-%d-%Y",
        // 4-digit year-first (ISO) + compact
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d",
        "%Y%m%d",
    ];
    let exprs: Vec<Expr> = FORMATS.iter()
        .map(|f| col(column).str().to_date(StrptimeOptions {
            format: Some((*f).into()),
            strict: false, exact: true, cache: true,
        }))
        .collect();
    coalesce(&exprs)
}

pub(super) fn parse_datetime_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
        "%Y/%m/%d %H:%M:%S", "%d/%m/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M",    "%d/%m/%Y %H:%M",
    ];
    let exprs: Vec<Expr> = FORMATS.iter()
        .map(|f| col(column).str().to_datetime(
            None,
            None,
            StrptimeOptions {
                format: Some((*f).into()),
                strict: false, exact: true, cache: true,
            },
            lit("raise"),
        ))
        .collect();
    coalesce(&exprs)
}

/// Parse a "dirty" numeric string to `f64`, tolerant of the shapes real
/// CSV exports carry — the dominant `type_consistency` gap (clean-score
/// corpus: 255 string columns that *want* to be numeric). Handles:
///   • surrounding currency / units — `€`, `$`, `£`, `EUR`, `HT`, `%` …
///     (anything that isn't a digit / sign / separator is dropped);
///   • thousands separators — ASCII space, NBSP, narrow-NBSP;
///   • the French decimal comma — `2114,29` → `2114.29`.
///
/// Separator rule: if BOTH `,` and `.` appear, the LAST is the decimal
/// point and the other is a thousands group (`1.234,56`→`1234.56`,
/// `1,234.56`→`1234.56`). If only `,` appears it's the decimal point
/// (French / EU default — RedPash's FR + Africa-first market). Only `.`
/// is left as-is (US / standard). Returns `None` when there's no number.
pub(super) fn normalize_numeric_cell(raw: &str) -> Option<f64> {
    // Keep sign / digits / separators / spaces; drop currency, letters, %.
    let kept: String = raw.chars()
        .filter(|c| c.is_ascii_digit()
            || matches!(c, ',' | '.' | '-' | '+' | ' ' | '\u{00A0}' | '\u{202F}'))
        .collect();
    let s = kept.replace([' ', '\u{00A0}', '\u{202F}'], ""); // spaces = thousands → drop
    if !s.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (has_comma, has_dot) = (s.contains(','), s.contains('.'));
    let normalized = if has_comma && has_dot {
        if s.rfind(',') > s.rfind('.') {
            s.replace('.', "").replace(',', ".") // 1.234,56 → 1234.56
        } else {
            s.replace(',', "")                   // 1,234.56 → 1234.56
        }
    } else if has_comma {
        s.replace(',', ".")                      // 2114,29 → 2114.29
    } else {
        s                                        // 1234 / 12.5 / -3
    };
    normalized.parse::<f64>().ok()
}

/// Parse a boolean from the many spellings real data carries, across EN +
/// FR (the founding locales). Polars' plain `cast(Boolean)` only knows
/// `true`/`false`, so `oui`/`non`/`yes`/`1`/`0` would null. Trimmed +
/// lowercased. Returns `None` for anything not clearly truthy/falsy (so a
/// genuine enum like `feminin`/`masculin` is left for the user, not coerced).
pub(super) fn normalize_bool_cell(raw: &str) -> Option<bool> {
    match raw.trim().to_lowercase().as_str() {
        "true" | "t" | "yes" | "y" | "oui" | "o" | "vrai" | "v" | "1" => Some(true),
        "false" | "f" | "no" | "n" | "non" | "faux" | "0" => Some(false),
        _ => None,
    }
}

/// Header → snake_case. Trims, lowercases, splits CamelCase boundaries,
/// collapses runs of `[ -.]` to a single `_`.
pub(super) fn snake_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_lower_or_digit = false;
    for ch in s.trim().chars() {
        if ch.is_uppercase() && prev_lower_or_digit {
            out.push('_');
        }
        match ch {
            ' ' | '-' | '.' | '/' => out.push('_'),
            c => out.extend(c.to_lowercase()),
        }
        prev_lower_or_digit = ch.is_lowercase() || ch.is_ascii_digit();
    }
    // Collapse runs of underscores + trim.
    let mut collapsed = String::with_capacity(out.len());
    let mut last_us = false;
    for ch in out.chars() {
        if ch == '_' {
            if !last_us && !collapsed.is_empty() {
                collapsed.push('_');
            }
            last_us = true;
        } else {
            collapsed.push(ch);
            last_us = false;
        }
    }
    collapsed.trim_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::{normalize_bool_cell, normalize_numeric_cell};

    #[test]
    fn numeric_handles_french_currency_and_thousands() {
        // French decimal comma, with/without currency + spaces.
        assert_eq!(normalize_numeric_cell("2114,29"), Some(2114.29));
        assert_eq!(normalize_numeric_cell("1667,63 €"), Some(1667.63));
        assert_eq!(normalize_numeric_cell("€911.18"), Some(911.18));
        assert_eq!(normalize_numeric_cell(" 729.65  "), Some(729.65));
        assert_eq!(normalize_numeric_cell("1000 EUR"), Some(1000.0));
        assert_eq!(normalize_numeric_cell("-3,5"), Some(-3.5));
        // Thousands separators — last separator is the decimal point.
        assert_eq!(normalize_numeric_cell("1 234,56"), Some(1234.56)); // space thousands, comma dec
        assert_eq!(normalize_numeric_cell("1.234,56"), Some(1234.56)); // dot thousands, comma dec
        assert_eq!(normalize_numeric_cell("1,234.56"), Some(1234.56)); // comma thousands, dot dec
        // No number → None (sentinels / blanks handled elsewhere).
        assert_eq!(normalize_numeric_cell("inconnu"), None);
        assert_eq!(normalize_numeric_cell(""), None);
        assert_eq!(normalize_numeric_cell("ND"), None);
    }

    #[test]
    fn bool_handles_en_fr_spellings() {
        for t in ["true", "TRUE", "oui", "Oui", "yes", "y", "1", "vrai", "o"] {
            assert_eq!(normalize_bool_cell(t), Some(true), "{t:?} should be true");
        }
        for f in ["false", "non", "NON", "no", "n", "0", "faux"] {
            assert_eq!(normalize_bool_cell(f), Some(false), "{f:?} should be false");
        }
        // A genuine enum is NOT a bool — left for the user, not coerced.
        assert_eq!(normalize_bool_cell("feminin"), None);
        assert_eq!(normalize_bool_cell("maybe"), None);
        assert_eq!(normalize_bool_cell(""), None);
    }

    #[test]
    fn date_flex_2digit_year_is_day_first_not_year_0002() {
        use polars::prelude::*;
        // The regression: "02/01/23" parsed to year 0002 because greedy
        // %Y ran before %d/%m/%y. Day-first dd/mm/yy must win → 2023-01-02.
        let df = df!["d" => ["02/01/23", "20/05/2020", "03/27/2023", "2021-02-16", "20211112"]].unwrap();
        let out = df.lazy()
            .select([super::parse_date_flex("d").dt().strftime("%Y-%m-%d").alias("d")])
            .collect().unwrap();
        let got: Vec<Option<&str>> = out.column("d").unwrap().str().unwrap().into_iter().collect();
        assert_eq!(got, vec![
            Some("2023-01-02"), // dd/mm/yy — NOT 0002-01-23
            Some("2020-05-20"), // dd/mm/yyyy
            Some("2023-03-27"), // mm/dd/yyyy (US; day 27 > 12 forces month-first)
            Some("2021-02-16"), // ISO
            Some("2021-11-12"), // compact yyyymmdd
        ]);
    }
}
