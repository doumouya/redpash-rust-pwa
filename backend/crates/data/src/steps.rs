//! Apply / replay cleaning steps against a Polars DataFrame.
//!
//! `apply` is the single switch from `kind` (string) → Polars op. Every
//! handler in the api crate that mutates a file's state goes through
//! `replay`: the canonical file is the on-disk CSV; the persistent
//! history is `project_steps`; the current view is the replay result.
//!
//! Supported kinds (Phase A complete set, except split / join / dates /
//! fix_invalid which land in Phase A.2):
//!
//!   drop_columns       params.cols: [string]
//!   drop_rows          params.indices: [int]
//!   drop_nulls         params.cols?: [string]   (empty → any-null row)
//!   fill_nulls         params.strategy: "fixed"|"zero"|"forward"
//!                      params.column?: string
//!                      params.value?:  string|number  (for fixed)
//!   cast               params.column: string, params.dtype: int|float|str|bool
//!   rename_column      params.from, params.to
//!   snake_case_columns no params; renames every header to snake_case
//!   replace_in_names   params.find: string, params.replace?: string
//!   change_case        params.mode: "lower"|"upper"|"title"
//!   filter_columns     params.cols: [string]    (columns to KEEP)
//!   filter_rows        params.combinator: "and"|"or"
//!                      params.predicates: [{ column, op, value?, case_sensitive? }]
//!                      ops: eq · neq · in · not_in · contains · starts_with ·
//!                           ends_with · gt · gte · lt · lte · between ·
//!                           before · after · is_null · not_null
//!                      Drops rows that fail the combined predicate — undoable
//!                      like every other step; canonical CSV stays intact.
//!   unwrap_csv         no params. Rescues a "wrapped" CSV — one where every
//!                      row parsed as a single quoted column because the
//!                      original separator was wrapped in quotes. Re-parses
//!                      the single column's values as CSV themselves.
//!   replace_text       params.column, params.find, params.replace?, params.is_regex?
//!                      remove_text = replace_text with replace=""

use crate::{DataError, Result};
use polars::prelude::*;
use std::collections::HashSet;

pub fn apply(df: DataFrame, kind: &str, params: &serde_json::Value) -> Result<DataFrame> {
    match kind {
        "drop_columns" => {
            let cols = arr_strings(params, "cols");
            if cols.is_empty() {
                return Err(DataError::InvalidSpec(
                    "drop_columns needs params.cols: [string]".into()));
            }
            let to_drop: HashSet<&str> = cols.iter().map(|s| s.as_str()).collect();
            let keep: Vec<String> = df.get_columns().iter()
                .map(|c| c.name().to_string())
                .filter(|n| !to_drop.contains(n.as_str()))
                .collect();
            select_keep(df, &keep)
        }

        "filter_columns" => {
            // params.cols = the names to KEEP, in the order to keep them.
            let cols = arr_strings(params, "cols");
            if cols.is_empty() {
                return Err(DataError::InvalidSpec(
                    "filter_columns needs params.cols: [string]".into()));
            }
            select_keep(df, &cols)
        }

        "drop_rows" => {
            let indices: Vec<u32> = params.get("indices")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                .unwrap_or_default();
            if indices.is_empty() {
                return Err(DataError::InvalidSpec(
                    "drop_rows needs params.indices: [int]".into()));
            }
            let n = df.height();
            let mut keep = vec![true; n];
            for i in indices {
                if let Some(slot) = keep.get_mut(i as usize) { *slot = false; }
            }
            let mask: BooleanChunked = keep.into_iter().collect();
            df.filter(&mask).map_err(DataError::from)
        }

        // params.combinator: "and" | "or"  (default "and")
        // params.predicates: [{ column, op, value?, case_sensitive? }]
        //
        // Each predicate translates to a single Polars Expr; the list is
        // folded with `&` or `|` per combinator, then passed to
        // `df.lazy().filter(combined)`. Empty predicate list is an error
        // (a no-op step would still be persisted to history and that
        // bloats the audit trail). `before` / `after` are string-typed
        // — the value is parsed lazily by Polars when compared against
        // a date column; numeric `lt/gt/etc` cast the value side via
        // `lit().cast(...)` so the predicate works across int / float
        // columns without per-row dtype branching.
        "filter_rows" => {
            let combinator = params.get("combinator").and_then(|v| v.as_str()).unwrap_or("and");
            let combine_or = matches!(combinator, "or" | "OR" | "Or");
            let preds = params.get("predicates").and_then(|v| v.as_array())
                .ok_or_else(|| DataError::InvalidSpec(
                    "filter_rows needs params.predicates: [{column, op, value?}]".into()))?;
            if preds.is_empty() {
                return Err(DataError::InvalidSpec(
                    "filter_rows needs at least one predicate".into()));
            }

            let mut combined: Option<Expr> = None;
            for p in preds {
                let column = p.get("column").and_then(|v| v.as_str())
                    .ok_or_else(|| DataError::InvalidSpec(
                        "filter_rows predicate missing `column`".into()))?;
                let op = p.get("op").and_then(|v| v.as_str())
                    .ok_or_else(|| DataError::InvalidSpec(
                        "filter_rows predicate missing `op`".into()))?;
                let case_sensitive = p.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(true);
                let value = p.get("value");

                let expr = build_filter_predicate(column, op, value, case_sensitive)?;
                combined = Some(match combined.take() {
                    None       => expr,
                    Some(prev) => if combine_or { prev.or(expr) } else { prev.and(expr) },
                });
            }
            let final_expr = combined.expect("predicates non-empty by check above");
            df.lazy().filter(final_expr).collect().map_err(DataError::from)
        }

        // Rescue a "wrapped" CSV upload. When the source file was
        // double-quoted with internal quotes escaped, every row parses
        // as one string column. The fix: take that single column's
        // values, prepend the (likely) embedded header, feed the
        // result back through the CSV parser.
        //
        // Refuses to operate on a DF with more than one column — at
        // that point the file is already unwrapped (probably from a
        // prior step) and re-parsing would silently corrupt it.
        "unwrap_csv" => {
            if df.width() != 1 {
                return Err(DataError::InvalidSpec(
                    "unwrap_csv only applies to a single-column DataFrame".into()));
            }
            let series = &df.get_columns()[0];
            // The original column header was the FIRST line of the
            // wrapped source — Polars treated it as the CSV header on
            // the initial parse, then each subsequent line became a
            // single-column row. Re-emit it as the first line of the
            // new buffer, then hand off to parse_text (which sniffs
            // delimiter + skips preamble, same as the upload pipeline).
            //
            // Defensive unwrap: when the source has inconsistent
            // wrapping (some lines `"…"`, some bare), Polars' first
            // parse leaves the inner content of some rows still
            // wrapped in `"…"`. Without the strip, the second parse
            // sees those as single-field quoted blobs and the result
            // ends up with a mix of quoted + unquoted columns. We
            // strip a balanced outer pair and unescape doubled `""`
            // BEFORE re-emitting — uses our parser as the
            // normalisation stage instead of nuking every `"` char
            // (the Django approach).
            fn defensive_unquote(s: &str) -> String {
                let t = s.trim();
                let inner = if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
                    &t[1..t.len() - 1]
                } else {
                    t
                };
                inner.replace("\"\"", "\"")
            }
            let header = defensive_unquote(&series.name().to_string());
            let mut buf = String::with_capacity(series.len() * 32);
            buf.push_str(&header);
            buf.push('\n');
            for i in 0..series.len() {
                let v = series.get(i).map_err(DataError::from)?;
                let raw = match v {
                    AnyValue::Null            => { buf.push('\n'); continue; }
                    AnyValue::String(s)       => s.to_string(),
                    AnyValue::StringOwned(s)  => s.to_string(),
                    other                     => other.to_string(),
                };
                buf.push_str(&defensive_unquote(&raw));
                buf.push('\n');
            }
            crate::parse::parse_text(buf)
        }

        "drop_nulls" => {
            // No subset → drop rows where ANY column is null.
            // Otherwise → drop rows where ANY listed column is null.
            let cols = arr_strings(params, "cols");
            let lf = df.lazy();
            let collected = if cols.is_empty() {
                lf.drop_nulls(None).collect()
            } else {
                let subset: Vec<Expr> = cols.iter().map(|c| col(c.as_str())).collect();
                lf.drop_nulls(Some(subset)).collect()
            };
            collected.map_err(DataError::from)
        }

        "fill_nulls" => {
            let strategy = params.get("strategy").and_then(|v| v.as_str()).unwrap_or("fixed");
            let one_col = params.get("column").and_then(|v| v.as_str()).map(String::from);
            let value   = params.get("value").map(json_to_string).unwrap_or_default();

            let names: Vec<String> = match &one_col {
                Some(c) => vec![c.clone()],
                None    => df.get_columns().iter().map(|c| c.name().to_string()).collect(),
            };

            let mut exprs: Vec<Expr> = Vec::with_capacity(names.len());
            for name in &names {
                let c = col(name.as_str());
                let filled = match strategy {
                    "fixed"   => c.fill_null(lit(value.clone())),
                    "zero"    => c.fill_null(lit(0i64)),
                    "forward" => c.forward_fill(None),
                    other     => return Err(DataError::InvalidSpec(
                        format!("unknown fill strategy: {other}"))),
                };
                exprs.push(filled.alias(name.as_str()));
            }
            df.lazy().with_columns(exprs).collect().map_err(DataError::from)
        }

        "cast" => {
            let column = params.get("column").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("cast needs params.column".into()))?;
            let dtype  = params.get("dtype").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("cast needs params.dtype".into()))?;

            // Take the existing dtype so we can branch: string-source
            // casts to date/datetime/time use multi-format strptime
            // (handles "/", "-", "." separators); other casts fall
            // through to Polars' built-in cast, which is non-strict —
            // unparseable values become null.
            let src_dtype  = df.column(column).map_err(DataError::from)?.dtype().clone();
            let is_str_src = matches!(src_dtype, DataType::String);

            let expr = match dtype {
                "int"      => col(column).cast(DataType::Int64),
                "float"    => col(column).cast(DataType::Float64),
                "str"      => col(column).cast(DataType::String),
                "bool"     => col(column).cast(DataType::Boolean),
                "date"     if is_str_src => parse_date_flex(column),
                "date"                   => col(column).cast(DataType::Date),
                "datetime" if is_str_src => parse_datetime_flex(column),
                "datetime"               => col(column).cast(DataType::Datetime(TimeUnit::Microseconds, None)),
                "time"     if is_str_src => col(column).str().to_time(default_strptime()),
                "time"                   => col(column).cast(DataType::Time),
                other => return Err(DataError::InvalidSpec(format!("unsupported dtype: {other}"))),
            };
            df.lazy().with_columns([expr.alias(column)]).collect().map_err(DataError::from)
        }

        "rename_column" => {
            let from = params.get("from").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec(
                    "rename_column needs params.from: string".into()))?;
            let to = params.get("to").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec(
                    "rename_column needs params.to: string".into()))?;
            df.lazy().rename([from], [to]).collect().map_err(DataError::from)
        }

        "snake_case_columns" => {
            let pairs: Vec<(String, String)> = df.get_columns().iter()
                .map(|c| {
                    let old = c.name().to_string();
                    let new = snake_case(&old);
                    (old, new)
                })
                .filter(|(a, b)| a != b)
                .collect();
            if pairs.is_empty() { return Ok(df); }
            let olds: Vec<&str> = pairs.iter().map(|(a, _)| a.as_str()).collect();
            let news: Vec<&str> = pairs.iter().map(|(_, b)| b.as_str()).collect();
            df.lazy().rename(olds, news).collect().map_err(DataError::from)
        }

        "replace_in_names" => {
            let find    = params.get("find").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec(
                    "replace_in_names needs params.find: string".into()))?;
            let replace = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            let pairs: Vec<(String, String)> = df.get_columns().iter()
                .map(|c| {
                    let old = c.name().to_string();
                    let new = old.replace(find, replace);
                    (old, new)
                })
                .filter(|(a, b)| a != b)
                .collect();
            if pairs.is_empty() { return Ok(df); }
            let olds: Vec<&str> = pairs.iter().map(|(a, _)| a.as_str()).collect();
            let news: Vec<&str> = pairs.iter().map(|(_, b)| b.as_str()).collect();
            df.lazy().rename(olds, news).collect().map_err(DataError::from)
        }

        "change_case" => {
            let mode = params.get("mode").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec(
                    "change_case needs params.mode: lower|upper".into()))?;
            let mut exprs: Vec<Expr> = Vec::new();
            for c in df.get_columns() {
                if !matches!(c.dtype(), DataType::String) { continue; }
                let name = c.name().to_string();
                let base = col(name.as_str());
                let transformed = match mode {
                    "lower" => base.str().to_lowercase(),
                    "upper" => base.str().to_uppercase(),
                    // "title" was supported by the Django app but Polars
                    // 0.43 omits the helper — wire back in once we have
                    // a `map_elements` solution or a newer Polars.
                    other   => return Err(DataError::InvalidSpec(
                        format!("unsupported change_case mode: {other}"))),
                };
                exprs.push(transformed.alias(name.as_str()));
            }
            if exprs.is_empty() { return Ok(df); }
            df.lazy().with_columns(exprs).collect().map_err(DataError::from)
        }

        "replace_text" => {
            let column   = params.get("column").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.column".into()))?;
            let find     = params.get("find").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("replace_text needs params.find".into()))?;
            let replace  = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            let is_regex = params.get("is_regex").and_then(|v| v.as_bool()).unwrap_or(false);

            let base = col(column).cast(DataType::String);
            let expr = if is_regex {
                base.str().replace_all(lit(find.to_string()), lit(replace.to_string()), false)
            } else {
                base.str().replace_all(lit(find.to_string()), lit(replace.to_string()), true)
            }.alias(column);
            df.lazy().with_columns([expr]).collect().map_err(DataError::from)
        }

        "fix_invalid" => {
            // Replace every cell whose value matches one of the listed
            // sentinels with `replacement` (or NULL if absent / null).
            // Two shapes accepted:
            //   • new: { sentinels: [...], columns?: [...] } — list of
            //     values to replace, applied to the listed columns (or
            //     all string columns when omitted). Drives the modal's
            //     "found in this file" multi-pick UX.
            //   • legacy: { column, sentinel } — single column, single
            //     value; preserved so old project_steps rows keep
            //     replaying cleanly.
            let replacement: Expr = match params.get("replacement") {
                None | Some(serde_json::Value::Null) => lit(LiteralValue::Null),
                Some(serde_json::Value::String(s))   => lit(s.clone()),
                Some(other)                          => lit(other.to_string()),
            };

            // Build the sentinel set — JSON array first, single value as fallback.
            let mut sentinels: Vec<String> = Vec::new();
            if let Some(serde_json::Value::Array(arr)) = params.get("sentinels") {
                for v in arr {
                    let s = match v {
                        serde_json::Value::String(s)   => s.clone(),
                        serde_json::Value::Null         => continue,
                        other                           => other.to_string(),
                    };
                    if !s.is_empty() { sentinels.push(s); }
                }
            }
            if sentinels.is_empty() {
                if let Some(v) = params.get("sentinel") {
                    let s = match v {
                        serde_json::Value::String(s)   => s.clone(),
                        serde_json::Value::Null         => return Err(DataError::InvalidSpec(
                            "fix_invalid needs params.sentinels (or legacy params.sentinel)".into())),
                        other                           => other.to_string(),
                    };
                    if !s.is_empty() { sentinels.push(s); }
                }
            }
            if sentinels.is_empty() {
                return Err(DataError::InvalidSpec(
                    "fix_invalid needs params.sentinels (non-empty)".into()));
            }

            // Resolve target columns. Explicit `columns` array wins;
            // legacy `column` next; otherwise every String-typed column.
            let target_cols: Vec<String> = if let Some(serde_json::Value::Array(arr)) = params.get("columns") {
                arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            } else if let Some(column) = params.get("column").and_then(|v| v.as_str()) {
                vec![column.to_string()]
            } else {
                df.get_columns().iter()
                    .filter(|s| matches!(s.dtype(), DataType::String))
                    .map(|s| s.name().to_string())
                    .collect()
            };
            if target_cols.is_empty() {
                return Err(DataError::InvalidSpec(
                    "fix_invalid: no target columns (frame has no string columns)".into()));
            }

            // Validate every target column exists before mutating the frame.
            let known: HashSet<String> = df.get_columns().iter()
                .map(|c| c.name().to_string()).collect();
            for c in &target_cols {
                if !known.contains(c) {
                    return Err(DataError::InvalidSpec(
                        format!("fix_invalid: unknown column {c:?}")));
                }
            }

            // One expression per target column — when ANY sentinel matches,
            // emit replacement; else keep the original value. Compare
            // cast-to-string so numeric sentinels (`"999"`) still match.
            let mut exprs: Vec<Expr> = Vec::with_capacity(target_cols.len());
            for cname in &target_cols {
                let mut cond: Option<Expr> = None;
                for s in &sentinels {
                    let c = col(cname).cast(DataType::String).eq(lit(s.clone()));
                    cond = Some(match cond { Some(prev) => prev.or(c), None => c });
                }
                // `unwrap` is safe: sentinels is non-empty (checked above).
                let cond = cond.unwrap();
                exprs.push(when(cond).then(replacement.clone()).otherwise(col(cname)).alias(cname));
            }
            df.lazy().with_columns(exprs).collect().map_err(DataError::from)
        }

        "join_columns" => {
            let col1 = params.get("col1").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("join_columns needs params.col1".into()))?;
            let col2 = params.get("col2").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("join_columns needs params.col2".into()))?;
            let sep  = params.get("sep").and_then(|v| v.as_str()).unwrap_or(" ").to_string();
            let new_name = params.get("new_name").and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("{col1}_{col2}"));

            let joined = concat_str(
                [col(col1).cast(DataType::String), col(col2).cast(DataType::String)],
                &sep,
                false,
            ).alias(new_name.as_str());

            // Add the new column, then keep everything but the two sources.
            let lf = df.lazy().with_columns([joined]).collect().map_err(DataError::from)?;
            let to_drop: HashSet<&str> = [col1, col2].into_iter().collect();
            let keep: Vec<String> = lf.get_columns().iter()
                .map(|c| c.name().to_string())
                .filter(|n| !to_drop.contains(n.as_str()))
                .collect();
            select_keep(lf, &keep)
        }

        "split_column" => {
            // Split `column` on `sep` into `column_1`, `column_2`, … —
            // up to MAX_PARTS new columns. `keep_original` defaults to
            // false (the source column is dropped after the split).
            const MAX_PARTS: usize = 10;
            let column = params.get("column").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("split_column needs params.column".into()))?;
            let sep = params.get("sep").and_then(|v| v.as_str()).unwrap_or(",").to_string();
            let keep_original = params.get("keep_original").and_then(|v| v.as_bool()).unwrap_or(false);

            // Pre-scan to find the max split count (caps at MAX_PARTS).
            let src = df.column(column).map_err(DataError::from)?;
            let mut max_parts = 1usize;
            for i in 0..src.len() {
                let v = src.get(i).map_err(DataError::from)?;
                let s = match v {
                    AnyValue::Null            => continue,
                    AnyValue::String(s)       => (*s).to_string(),
                    AnyValue::StringOwned(s)  => s.to_string(),
                    other                     => other.to_string(),
                };
                let parts = s.split(sep.as_str()).count();
                if parts > max_parts { max_parts = parts; }
                if max_parts >= MAX_PARTS { break; }
            }
            let n = max_parts.min(MAX_PARTS);

            // Build a list-typed split expression once, then peel
            // elements out via list().get(i).
            let split = col(column).str().split(lit(sep)).alias("__split_tmp__");

            let mut new_cols: Vec<Expr> = Vec::with_capacity(n);
            for i in 0..n {
                let part_name = format!("{column}_{}", i + 1);
                new_cols.push(
                    split.clone().list().get(lit(i as i64), true).alias(part_name.as_str()),
                );
            }
            let lf = df.lazy().with_columns(new_cols).collect().map_err(DataError::from)?;
            if keep_original { Ok(lf) }
            else {
                let to_drop: HashSet<&str> = [column].into_iter().collect();
                let keep: Vec<String> = lf.get_columns().iter()
                    .map(|c| c.name().to_string())
                    .filter(|n| !to_drop.contains(n.as_str()))
                    .collect();
                select_keep(lf, &keep)
            }
        }

        "format_dates" => {
            // Parse `column` as a Date with flexible matching, then
            // restringify with `fmt` (default ISO).
            //   on_incomplete = "null" → unparseable become null
            //   on_incomplete = "drop" → row is filtered out
            //   on_incomplete = "keep" → original value is preserved
            let column = params.get("column").and_then(|v| v.as_str())
                .ok_or_else(|| DataError::InvalidSpec("format_dates needs params.column".into()))?;
            let fmt = params.get("fmt").and_then(|v| v.as_str()).unwrap_or("%Y-%m-%d").to_string();
            let on_incomplete = params.get("on_incomplete").and_then(|v| v.as_str()).unwrap_or("null");

            // Multi-format parser — handles ISO, slash, dot, and dotted
            // European styles. See parse_date_flex below.
            let parsed = parse_date_flex(column);
            let formatted = parsed.clone().dt().strftime(fmt.as_str());

            let new_value = match on_incomplete {
                "null" | "drop" => formatted,
                "keep"          => formatted.fill_null(col(column).cast(DataType::String)),
                other => return Err(DataError::InvalidSpec(
                    format!("unsupported on_incomplete: {other}"))),
            };
            let with_new = df.lazy().with_columns([new_value.alias(column)]);
            let result = if on_incomplete == "drop" {
                with_new.filter(col(column).is_not_null())
            } else {
                with_new
            };
            result.collect().map_err(DataError::from)
        }

        other => Err(DataError::InvalidSpec(format!("unknown step kind: {other}"))),
    }
}

/// Apply a sequence of steps in order. Used by the api crate's hydrate
/// path to reconstruct the current view from the base CSV.
pub fn replay(base: DataFrame, steps: &[(&str, serde_json::Value)]) -> Result<DataFrame> {
    let mut df = base;
    for (kind, params) in steps {
        df = apply(df, kind, params)?;
    }
    Ok(df)
}

// ─── helpers ────────────────────────────────────────────────────

fn arr_strings(params: &serde_json::Value, key: &str) -> Vec<String> {
    params.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null      => String::new(),
        other                        => other.to_string(),
    }
}

fn select_keep(df: DataFrame, keep: &[String]) -> Result<DataFrame> {
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
fn build_filter_predicate(
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

fn default_strptime() -> StrptimeOptions {
    StrptimeOptions { format: None, strict: false, exact: false, cache: true }
}

/// Try several common date layouts and take the first that parses.
/// Polars' default `cast(Date)` only accepts ISO `YYYY-MM-DD`, so
/// strings like `2021/02/16` or `16/02/2021` would otherwise become null.
fn parse_date_flex(column: &str) -> Expr {
    const FORMATS: &[&str] = &[
        "%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y",
        "%d-%m-%Y", "%d.%m.%Y", "%Y%m%d",
    ];
    let exprs: Vec<Expr> = FORMATS.iter()
        .map(|f| col(column).str().to_date(StrptimeOptions {
            format: Some((*f).into()),
            strict: false, exact: true, cache: true,
        }))
        .collect();
    coalesce(&exprs)
}

fn parse_datetime_flex(column: &str) -> Expr {
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

/// Header → snake_case. Trims, lowercases, splits CamelCase boundaries,
/// collapses runs of `[ -.]` to a single `_`.
fn snake_case(s: &str) -> String {
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
