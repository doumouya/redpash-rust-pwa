//! Purpose: step-engine helpers — JSON-arg extraction, the filter-predicate
//! compiler (consuming the canonical FilterNode shape), and the LOCALE
//! COERCION (FR number/bool/date heuristics). Ported verbatim — these encode
//! hard-won corpus knowledge (the year-0002 regression, the 255 numeric-intent
//! string columns) and are the product's actual moat over naive CSV ingestion.

use polars::prelude::*;

use crate::{DataError, Result};

pub(super) fn arr_strings(params: &serde_json::Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

pub(super) fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub(super) fn select_keep(df: DataFrame, keep: &[String]) -> Result<DataFrame> {
    let refs: Vec<&str> = keep.iter().map(|s| s.as_str()).collect();
    df.select(refs).map_err(DataError::from)
}

/// One Polars Expr for a filter predicate. Numeric ops cast the value to f64
/// (Polars widens the column side); string ops cast the COLUMN to String
/// (guards against drift to Categorical/Utf8View); date ops parse the value
/// lazily — a bogus date drops every row (loud failure beats silent keep).
///
/// `pub(crate)` so `crate::filter::apply_filter` (the FilterNode tree walker)
/// and the `filter_rows` step share ONE predicate compiler — there is no
/// second op→Expr match anywhere in the engine (the day-one "one filter
/// shape" promise).
pub(crate) fn build_filter_predicate(
    column: &str,
    op: &str,
    value: Option<&serde_json::Value>,
    case_sensitive: bool,
) -> Result<Expr> {
    let c = col(column);
    let need_value = || -> Result<&serde_json::Value> {
        value.ok_or_else(|| DataError::InvalidSpec(format!("filter op `{op}` needs a value")))
    };
    let val_string = || -> Result<String> { Ok(json_to_string(need_value()?)) };
    let val_f64 = || -> Result<f64> {
        let v = need_value()?;
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .ok_or_else(|| DataError::InvalidSpec(format!("filter op `{op}` needs a numeric value")))
    };
    let val_array = || -> Result<Vec<String>> {
        let v = need_value()?;
        v.as_array()
            .map(|a| a.iter().map(json_to_string).collect())
            .ok_or_else(|| DataError::InvalidSpec(format!("filter op `{op}` needs an array value")))
    };

    Ok(match op {
        "eq" => c.cast(DataType::String).eq(lit(val_string()?)),
        "neq" => c.cast(DataType::String).neq(lit(val_string()?)),
        "in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(false)
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter().map(|v| s.clone().eq(lit(v))).reduce(|a, b| a.or(b)).unwrap()
            }
        }
        "not_in" => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(true)
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter().map(|v| s.clone().neq(lit(v))).reduce(|a, b| a.and(b)).unwrap()
            }
        }
        "contains" => {
            let pat = val_string()?;
            if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase().str().contains_literal(lit(pat.to_lowercase()))
            }
        }
        "not_contains" => {
            let pat = val_string()?;
            let inner = if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase().str().contains_literal(lit(pat.to_lowercase()))
            };
            inner.not()
        }
        "starts_with" => c.cast(DataType::String).str().starts_with(lit(val_string()?)),
        "ends_with" => c.cast(DataType::String).str().ends_with(lit(val_string()?)),
        "gt" => c.gt(lit(val_f64()?)),
        "gte" => c.gt_eq(lit(val_f64()?)),
        "lt" => c.lt(lit(val_f64()?)),
        "lte" => c.lt_eq(lit(val_f64()?)),
        "between" => {
            let arr = need_value()?.as_array().ok_or_else(|| {
                DataError::InvalidSpec("filter op `between` needs value: [low, high]".into())
            })?;
            if arr.len() != 2 {
                return Err(DataError::InvalidSpec(
                    "filter op `between` needs exactly two endpoints".into(),
                ));
            }
            let parse = |v: &serde_json::Value| -> Result<f64> {
                v.as_f64()
                    .or_else(|| v.as_i64().map(|n| n as f64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .ok_or_else(|| DataError::InvalidSpec("between endpoints must be numeric".into()))
            };
            let lo = parse(&arr[0])?;
            let hi = parse(&arr[1])?;
            c.clone().gt_eq(lit(lo)).and(c.lt_eq(lit(hi)))
        }
        "is_null" => c.is_null(),
        "not_null" => c.is_not_null(),
        other => return Err(DataError::InvalidSpec(format!("unsupported filter op: {other}"))),
    })
}

pub(super) fn default_strptime() -> StrptimeOptions {
    StrptimeOptions { format: None, strict: false, exact: false, cache: true }
}

/// Try several date layouts, take the first that parses. DAY-FIRST precedes
/// month-first and 2-digit-year (`%y`) precedes `%Y` — RedPash's FR/Africa
/// default, and the fix for greedy `%Y` parsing "02/01/23" as year 0002.
pub(super) fn parse_date_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%d/%m/%y", "%d-%m-%y", "%d.%m.%y", // 2-digit, day-first (FR/Africa)
        "%m/%d/%y", // 2-digit, month-first (US)
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%m/%d/%Y", "%m-%d-%Y",
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d",
    ];
    let exprs: Vec<Expr> = FORMATS
        .iter()
        .map(|f| {
            col(column).str().to_date(StrptimeOptions {
                format: Some((*f).into()),
                strict: false,
                exact: true,
                cache: true,
            })
        })
        .collect();
    coalesce(&exprs)
}

pub(super) fn parse_datetime_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d %H:%M:%S",
        "%d/%m/%Y %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M",
    ];
    let exprs: Vec<Expr> = FORMATS
        .iter()
        .map(|f| {
            col(column).str().to_datetime(
                None,
                None,
                StrptimeOptions { format: Some((*f).into()), strict: false, exact: true, cache: true },
                lit("raise"),
            )
        })
        .collect();
    coalesce(&exprs)
}

/// Parse a "dirty" numeric string tolerant of real CSV shapes — strips
/// currency/units/spaces, resolves `,` vs `.` by "last separator is the
/// decimal" (1.234,56 → 1234.56), and treats a lone comma as the FR decimal
/// (2114,29 → 2114.29). None when there's no number.
pub(super) fn normalize_numeric_cell(raw: &str) -> Option<f64> {
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | '-' | '+' | ' ' | '\u{00A0}' | '\u{202F}'))
        .collect();
    let s = kept.replace([' ', '\u{00A0}', '\u{202F}'], "");
    if !s.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (has_comma, has_dot) = (s.contains(','), s.contains('.'));
    let normalized = if has_comma && has_dot {
        if s.rfind(',') > s.rfind('.') {
            s.replace('.', "").replace(',', ".")
        } else {
            s.replace(',', "")
        }
    } else if has_comma {
        s.replace(',', ".")
    } else {
        s
    };
    normalized.parse::<f64>().ok()
}

/// Parse a bool from EN+FR spellings. None for anything not clearly truthy/
/// falsy (a genuine enum like feminin/masculin is left for the user).
pub(super) fn normalize_bool_cell(raw: &str) -> Option<bool> {
    match raw.trim().to_lowercase().as_str() {
        "true" | "t" | "yes" | "y" | "oui" | "o" | "vrai" | "v" | "1" => Some(true),
        "false" | "f" | "no" | "n" | "non" | "faux" | "0" => Some(false),
        _ => None,
    }
}

/// Header → snake_case: trim, lowercase, split CamelCase, collapse `[ -./]`.
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
    use super::{normalize_bool_cell, normalize_numeric_cell, parse_date_flex};
    use polars::prelude::*;

    #[test]
    fn numeric_handles_french_currency_and_thousands() {
        assert_eq!(normalize_numeric_cell("2114,29"), Some(2114.29));
        assert_eq!(normalize_numeric_cell("1667,63 €"), Some(1667.63));
        assert_eq!(normalize_numeric_cell("€911.18"), Some(911.18));
        assert_eq!(normalize_numeric_cell("1000 EUR"), Some(1000.0));
        assert_eq!(normalize_numeric_cell("-3,5"), Some(-3.5));
        assert_eq!(normalize_numeric_cell("1 234,56"), Some(1234.56));
        assert_eq!(normalize_numeric_cell("1.234,56"), Some(1234.56));
        assert_eq!(normalize_numeric_cell("1,234.56"), Some(1234.56));
        assert_eq!(normalize_numeric_cell("inconnu"), None);
        assert_eq!(normalize_numeric_cell(""), None);
    }

    #[test]
    fn bool_handles_en_fr_spellings() {
        for t in ["true", "oui", "yes", "y", "1", "vrai", "o"] {
            assert_eq!(normalize_bool_cell(t), Some(true), "{t:?}");
        }
        for f in ["false", "non", "no", "0", "faux"] {
            assert_eq!(normalize_bool_cell(f), Some(false), "{f:?}");
        }
        assert_eq!(normalize_bool_cell("feminin"), None);
    }

    #[test]
    fn date_flex_2digit_year_is_day_first_not_year_0002() {
        let df = df!["d" => ["02/01/23", "20/05/2020", "03/27/2023", "2021-02-16", "20211112"]].unwrap();
        let out = df
            .lazy()
            .select([parse_date_flex("d").dt().strftime("%Y-%m-%d").alias("d")])
            .collect()
            .unwrap();
        let got: Vec<Option<&str>> = out.column("d").unwrap().str().unwrap().iter().collect();
        assert_eq!(
            got,
            vec![
                Some("2023-01-02"), // dd/mm/yy — NOT 0002-01-23
                Some("2020-05-20"),
                Some("2023-03-27"), // day 27 forces month-first
                Some("2021-02-16"),
                Some("2021-11-12"),
            ]
        );
    }
}
