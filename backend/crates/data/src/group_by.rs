//! Doc: docs/internal/code/backend/data/group_by.md
//! Group-by + aggregation engine for the Reports page.
//!
//! `execute(df, spec)` applies the optional pre-filter, groups by the
//! requested columns, runs each aggregation as a Polars Expr, and
//! returns the resulting DataFrame. The api crate stringifies the rows
//! for transport (same shape as the redtable page response).
//!
//! Supported aggregations (map to Polars Expr):
//!   count           → `col.count()` on every value, including nulls.
//!   count_distinct  → `col.n_unique()`.
//!   sum             → `col.sum()` (numeric).
//!   mean            → `col.mean()`.
//!   min, max        → `col.min()` / `col.max()`.
//!   first, last     → `col.first()` / `col.last()` — useful when
//!                     grouping by an id and pulling along a label.

use crate::{DataError, Result};
use polars::prelude::*;
use shared::filter::{FilterNode, GroupOp, PredOp};
use shared::report::{AggFn, Aggregation, ReportSpec};

pub fn execute(df: &DataFrame, spec: &ReportSpec) -> Result<DataFrame> {
    // 1. Optional pre-filter via the same FilterNode tree the cleaner uses.
    //    The reference routed this through `parse::apply_filter` (which took a
    //    JSON string); redpash-next has no such entry point and the cleaner's
    //    predicate compiler is private to `steps`, so we deserialise the
    //    free-form `spec.filter` value into the CANONICAL `shared::FilterNode`
    //    tree and compile it to a Polars Expr right here. Empty / null filters
    //    leave the frame untouched, exactly like the reference.
    let mut lf = df.clone().lazy();
    if let Some(v) = spec.filter.as_ref() {
        if !v.is_null() {
            if let Some(expr) = filter_value_to_expr(v)? {
                lf = lf.filter(expr);
            }
        }
    }

    // 2. Combined group keys = row groups + column groups. The matrix
    //    layout is a frontend concern; from Polars' perspective it's
    //    just one big group_by over both dimensions.
    let combined: Vec<String> = spec
        .group_by
        .iter()
        .chain(spec.group_by_cols.iter())
        .cloned()
        .collect();

    // 3. Aggregations. If the caller asked for grouping but no aggs,
    //    add an implicit row-count so the result is never empty.
    let mut effective_aggs = spec.aggregations.clone();
    if !combined.is_empty() && effective_aggs.is_empty() {
        effective_aggs.push(Aggregation {
            col: "*".into(),
            fn_: AggFn::Count,
            alias: Some("count".into()),
        });
    }
    let agg_exprs = build_agg_exprs(&effective_aggs)?;

    // 4. Group-by. With no group columns we want a single summary row,
    //    so we `select` over the aggregation exprs directly.
    let lf2 = if combined.is_empty() {
        if agg_exprs.is_empty() {
            let n = df.height() as i64;
            return df! {"rows" => &[n]}.map_err(DataError::from);
        }
        lf.select(agg_exprs)
    } else {
        let group_exprs: Vec<Expr> = combined.iter().map(|c| col(c.as_str())).collect();
        lf.group_by(group_exprs).agg(agg_exprs)
    };

    // 5. Collect, then sort eagerly. Lazy `sort_by_exprs` chained off
    //    `group_by().agg()` has been observed to silently drop in some
    //    Polars builds — eager `DataFrame::sort` reliably applies.
    let mut df = lf2.collect().map_err(DataError::from)?;

    // 5b. Apply aggregate window functions to the subtotals frame
    //     (derived columns like "% of partition", "partition total
    //     broadcast"). Runs before sort/top_n so users can sort by
    //     or top-N filter on the window-derived columns.
    if !spec.windows.is_empty() {
        df = apply_windows(df, &spec.windows)?;
    }
    if !spec.sort.is_empty() || !spec.group_by.is_empty() {
        // Build the sort plan: every user-specified key in order, with
        // its requested direction. Then append remaining group-by
        // columns as ascending tie-breakers so subtotals stay
        // hierarchically grouped even with custom sorts.
        let mut by: Vec<String> = Vec::new();
        let mut descending: Vec<bool> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for s in &spec.sort {
            if s.col.is_empty() || !seen.insert(s.col.clone()) {
                continue;
            }
            by.push(s.col.clone());
            descending.push(s.dir.eq_ignore_ascii_case("desc"));
        }
        for gb in &spec.group_by {
            if seen.insert(gb.clone()) {
                by.push(gb.clone());
                descending.push(false);
            }
        }
        if !by.is_empty() && !spec.sort.is_empty() {
            // Only sort when the USER asked. Auto-tie-breakers without a
            // user sort would silently reorder against the natural Polars
            // group-by output, which the cleaner panel might rely on.
            let opts = SortMultipleOptions::default().with_order_descending_multi(descending);
            df = df.sort(by, opts).map_err(DataError::from)?;
        }
    }

    // 6. Top-N filter (post-aggregation). Applied last so user sorts
    //    above don't get clobbered by the per-partition sort the Top-N
    //    pipeline needs. Sorts subtotals by `order_by` (within each
    //    `partition_by` group via group_by_stable + head) and keeps
    //    the first N rows. The final sort from step 5 still applies
    //    AFTER, since we re-sort the trimmed frame.
    if let Some(top) = spec.top_n.as_ref() {
        if top.n > 0 && !top.order_by.is_empty() {
            df = apply_top_n(df, top, &spec.group_by)?;
        }
    }
    Ok(df)
}

/// Deserialise the free-form `spec.filter` JSON value into the canonical
/// `shared::FilterNode` tree and compile it to a single Polars predicate.
/// `Ok(None)` means "no constraint" (null filter or an empty AND group);
/// the caller then skips `lf.filter` entirely.
fn filter_value_to_expr(v: &serde_json::Value) -> Result<Option<Expr>> {
    let node: FilterNode = serde_json::from_value(v.clone())
        .map_err(|e| DataError::InvalidSpec(format!("report filter: {e}")))?;
    tree_expr(&node)
}

/// Recursively turn a FilterNode into a Polars Expr.
/// `Ok(None)` means "no constraint" (e.g. empty AND group); the caller
/// then skips applying any filter rather than wasting an Expr.
fn tree_expr(node: &FilterNode) -> Result<Option<Expr>> {
    match node {
        FilterNode::Pred { col, op, value, case_sensitive } => {
            Ok(Some(pred_expr(col, *op, value.as_ref(), *case_sensitive)?))
        }
        FilterNode::Group { op, children } => {
            // Empty groups: empty AND = TRUE (no-op), empty OR = FALSE.
            if children.is_empty() {
                return Ok(match op {
                    GroupOp::And => None,
                    GroupOp::Or => Some(lit(false)),
                });
            }
            let mut acc: Option<Expr> = None;
            for child in children {
                if let Some(ce) = tree_expr(child)? {
                    acc = Some(match (acc.take(), op) {
                        (None, _) => ce,
                        (Some(a), GroupOp::And) => a.and(ce),
                        (Some(a), GroupOp::Or) => a.or(ce),
                    });
                }
            }
            Ok(acc)
        }
    }
}

/// One Polars Expr for a single leaf predicate. Numeric ops cast the value to
/// f64 (Polars widens the column side); string ops cast the COLUMN to String
/// (guards against drift to Categorical/Utf8View). Mirrors the cleaner's
/// `steps::util::build_filter_predicate` semantics so report pre-filters and
/// persisted filter_rows steps behave identically.
fn pred_expr(
    column: &str,
    op: PredOp,
    value: Option<&serde_json::Value>,
    case_sensitive: bool,
) -> Result<Expr> {
    let c = col(column);
    let op_label = |o: PredOp| -> &'static str {
        match o {
            PredOp::Eq => "eq",
            PredOp::Neq => "neq",
            PredOp::Contains => "contains",
            PredOp::NotContains => "not_contains",
            PredOp::StartsWith => "starts_with",
            PredOp::EndsWith => "ends_with",
            PredOp::Gt => "gt",
            PredOp::Gte => "gte",
            PredOp::Lt => "lt",
            PredOp::Lte => "lte",
            PredOp::Between => "between",
            PredOp::In => "in",
            PredOp::IsNull => "is_null",
            PredOp::NotNull => "not_null",
        }
    };
    let need_value = || -> Result<&serde_json::Value> {
        value.ok_or_else(|| {
            DataError::InvalidSpec(format!("filter op `{}` needs a value", op_label(op)))
        })
    };
    let json_to_string = |v: &serde_json::Value| -> String {
        match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        }
    };
    let val_string = || -> Result<String> { Ok(json_to_string(need_value()?)) };
    let val_f64 = || -> Result<f64> {
        let v = need_value()?;
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .ok_or_else(|| {
                DataError::InvalidSpec(format!(
                    "filter op `{}` needs a numeric value",
                    op_label(op)
                ))
            })
    };
    let val_array = || -> Result<Vec<String>> {
        let v = need_value()?;
        v.as_array()
            .map(|a| a.iter().map(&json_to_string).collect())
            .ok_or_else(|| {
                DataError::InvalidSpec(format!("filter op `{}` needs an array value", op_label(op)))
            })
    };

    Ok(match op {
        PredOp::Eq => c.cast(DataType::String).eq(lit(val_string()?)),
        PredOp::Neq => c.cast(DataType::String).neq(lit(val_string()?)),
        PredOp::In => {
            let needles = val_array()?;
            if needles.is_empty() {
                lit(false)
            } else {
                let s = c.cast(DataType::String);
                needles.into_iter().map(|v| s.clone().eq(lit(v))).reduce(|a, b| a.or(b)).unwrap()
            }
        }
        PredOp::Contains => {
            let pat = val_string()?;
            if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase().str().contains_literal(lit(pat.to_lowercase()))
            }
        }
        PredOp::NotContains => {
            let pat = val_string()?;
            let inner = if case_sensitive {
                c.cast(DataType::String).str().contains_literal(lit(pat))
            } else {
                c.cast(DataType::String).str().to_lowercase().str().contains_literal(lit(pat.to_lowercase()))
            };
            inner.not()
        }
        PredOp::StartsWith => c.cast(DataType::String).str().starts_with(lit(val_string()?)),
        PredOp::EndsWith => c.cast(DataType::String).str().ends_with(lit(val_string()?)),
        PredOp::Gt => c.gt(lit(val_f64()?)),
        PredOp::Gte => c.gt_eq(lit(val_f64()?)),
        PredOp::Lt => c.lt(lit(val_f64()?)),
        PredOp::Lte => c.lt_eq(lit(val_f64()?)),
        PredOp::Between => {
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
        PredOp::IsNull => c.is_null(),
        PredOp::NotNull => c.is_not_null(),
    })
}

fn apply_windows(df: DataFrame, windows: &[shared::report::WindowSpec]) -> Result<DataFrame> {
    let mut lf = df.lazy();
    for w in windows {
        if w.alias.is_empty() || w.col.is_empty() {
            continue;
        }
        let base = col(w.col.as_str());
        let parts: Vec<Expr> = w.partition_by.iter().map(|c| col(c.as_str())).collect();

        let derived = match w.fn_.as_str() {
            // ── Aggregate windows (Phase B) ─────────────────────
            "sum" | "mean" | "count" | "min" | "max" => {
                let agg = match w.fn_.as_str() {
                    "sum" => base.clone().sum(),
                    "mean" => base.clone().mean(),
                    "count" => base.clone().count(),
                    "min" => base.clone().min(),
                    "max" => base.clone().max(),
                    _ => unreachable!(),
                };
                let windowed = if parts.is_empty() {
                    agg
                } else {
                    agg.over(parts)?
                };
                if w.as_percent {
                    // x / window * 100 — explicit float cast so
                    // integer division doesn't silently produce 0s.
                    (base / windowed.cast(DataType::Float64) * lit(100.0)).alias(w.alias.as_str())
                } else {
                    windowed.alias(w.alias.as_str())
                }
            }
            // ── Value windows (Phase C) ─────────────────────────
            // All require an order_by to make "previous" / "first"
            // deterministic. We sort the lazy frame once *before*
            // computing the expression so the partition's natural
            // order matches the user's intent.
            "lag" | "lead" | "first_value" | "last_value" => {
                let Some(ob) = w.order_by.as_deref().filter(|s| !s.is_empty()) else {
                    continue;
                };
                lf = lf.sort_by_exprs(
                    vec![col(ob)],
                    SortMultipleOptions::default().with_order_descending_multi(vec![false]),
                );
                let offset = w.offset.max(1) as i64;
                let inner = match w.fn_.as_str() {
                    "lag" => base.clone().shift(lit(offset)),
                    "lead" => base.clone().shift(lit(-offset)),
                    "first_value" => base.clone().first(),
                    "last_value" => base.clone().last(),
                    _ => unreachable!(),
                };
                if parts.is_empty() {
                    inner.alias(w.alias.as_str())
                } else {
                    inner.over(parts)?.alias(w.alias.as_str())
                }
            }
            _ => continue,
        };
        lf = lf.with_columns([derived]);
    }
    lf.collect().map_err(DataError::from)
}

fn apply_top_n(
    df: DataFrame,
    top: &shared::report::TopNFilter,
    fallback_part: &[String],
) -> Result<DataFrame> {
    let descending = top.direction.eq_ignore_ascii_case("desc");
    let sort_opts = SortMultipleOptions::default().with_order_descending_multi(vec![descending]);
    // Default partition_by to the report's group_by[0..n-1] minus the
    // last level — i.e. "top N of the deepest dimension within each
    // outer group". Empty means global top-N.
    let partition: Vec<String> = if !top.partition_by.is_empty() {
        top.partition_by.clone()
    } else if fallback_part.len() > 1 {
        fallback_part[..fallback_part.len() - 1].to_vec()
    } else {
        Vec::new()
    };

    if partition.is_empty() {
        // Global top-N: sort + head.
        let sorted = df.sort([top.order_by.as_str()], sort_opts)?;
        return Ok(sorted.head(Some(top.n as usize)));
    }

    let part_exprs: Vec<Expr> = partition.iter().map(|c| col(c.as_str())).collect();
    let lf = df
        .lazy()
        .sort_by_exprs(vec![col(top.order_by.as_str())], sort_opts)
        .group_by_stable(part_exprs)
        .head(Some(top.n as usize));
    lf.collect().map_err(DataError::from)
}

fn build_agg_exprs(aggs: &[Aggregation]) -> Result<Vec<Expr>> {
    let mut out = Vec::with_capacity(aggs.len());
    for a in aggs {
        let base = if a.col == "*" {
            // Count-of-rows shortcut. `len()` works regardless of column
            // existence and matches user expectations.
            lit(1i64)
        } else {
            col(a.col.as_str())
        };
        let alias = a.alias.clone().unwrap_or_else(|| default_alias(a));
        let expr = match a.fn_ {
            AggFn::Count => base.count(),
            AggFn::CountDistinct => base.n_unique(),
            AggFn::Sum => base.sum(),
            AggFn::Mean => base.mean(),
            AggFn::Min => base.min(),
            AggFn::Max => base.max(),
            AggFn::First => base.first(),
            AggFn::Last => base.last(),
            AggFn::Median => base.median(),
            AggFn::Q1 => base.quantile(lit(0.25), QuantileMethod::Linear),
            AggFn::Q3 => base.quantile(lit(0.75), QuantileMethod::Linear),
        }
        .alias(alias.as_str());
        out.push(expr);
    }
    Ok(out)
}

fn default_alias(a: &Aggregation) -> String {
    let fn_label = match a.fn_ {
        AggFn::Count => "count",
        AggFn::CountDistinct => "distinct",
        AggFn::Sum => "sum",
        AggFn::Mean => "mean",
        AggFn::Min => "min",
        AggFn::Max => "max",
        AggFn::First => "first",
        AggFn::Last => "last",
        AggFn::Median => "median",
        AggFn::Q1 => "q1",
        AggFn::Q3 => "q3",
    };
    if a.col == "*" {
        fn_label.to_string()
    } else {
        format!("{}_{fn_label}", a.col)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::report::{SortSpec, TopNFilter, WindowSpec};

    fn sample() -> DataFrame {
        df![
            "city"   => ["Paris", "Paris", "Lyon", "Lyon", "Lyon"],
            "plan"   => ["A", "B", "A", "A", "B"],
            "amount" => [100i64, 200, 50, 70, 30],
        ]
        .unwrap()
    }

    fn agg(col: &str, fn_: AggFn, alias: &str) -> Aggregation {
        Aggregation { col: col.into(), fn_, alias: Some(alias.into()) }
    }

    #[test]
    fn group_and_sum_aggregates_per_key() {
        let spec = ReportSpec {
            group_by: vec!["city".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        assert_eq!(out.height(), 2);
        assert!(out.get_column_names().iter().any(|n| n.as_str() == "total"));
    }

    #[test]
    fn no_group_no_agg_returns_row_count() {
        let spec = ReportSpec::default();
        let out = execute(&sample(), &spec).unwrap();
        // Single summary cell with the source row count.
        assert_eq!(out.shape(), (1, 1));
        let rows = out.column("rows").unwrap().i64().unwrap().get(0).unwrap();
        assert_eq!(rows, 5);
    }

    #[test]
    fn group_with_no_agg_gets_implicit_count() {
        let spec = ReportSpec { group_by: vec!["city".into()], ..Default::default() };
        let out = execute(&sample(), &spec).unwrap();
        assert_eq!(out.height(), 2);
        assert!(out.get_column_names().iter().any(|n| n.as_str() == "count"));
    }

    #[test]
    fn no_group_with_agg_is_single_summary_row() {
        let spec = ReportSpec {
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        assert_eq!(out.height(), 1);
        let total = out.column("total").unwrap().i64().unwrap().get(0).unwrap();
        assert_eq!(total, 450);
    }

    #[test]
    fn user_sort_descending_orders_subtotals() {
        let spec = ReportSpec {
            group_by: vec!["city".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            sort: vec![SortSpec { col: "total".into(), dir: "desc".into() }],
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        let totals: Vec<Option<i64>> = out.column("total").unwrap().i64().unwrap().iter().collect();
        // Paris=300 should precede Lyon=150 under desc sort.
        assert_eq!(totals, vec![Some(300), Some(150)]);
    }

    #[test]
    fn pre_filter_restricts_rows_before_grouping() {
        let spec = ReportSpec {
            group_by: vec!["city".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            filter: Some(serde_json::json!({
                "node": "pred",
                "col": "plan",
                "op": "eq",
                "value": "A"
            })),
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        // Only plan==A rows survive: Paris(100), Lyon(50+70=120).
        let mut pairs: Vec<(String, i64)> = out
            .column("city")
            .unwrap()
            .str()
            .unwrap()
            .iter()
            .zip(out.column("total").unwrap().i64().unwrap().iter())
            .map(|(c, t)| (c.unwrap().to_string(), t.unwrap()))
            .collect();
        pairs.sort();
        assert_eq!(pairs, vec![("Lyon".into(), 120), ("Paris".into(), 100)]);
    }

    #[test]
    fn aggregate_window_percent_of_partition() {
        let spec = ReportSpec {
            group_by: vec!["city".into(), "plan".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            windows: vec![WindowSpec {
                alias: "pct".into(),
                fn_: "sum".into(),
                col: "total".into(),
                partition_by: vec!["city".into()],
                as_percent: true,
                order_by: None,
                offset: 1,
            }],
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        assert!(out.get_column_names().iter().any(|n| n.as_str() == "pct"));
    }

    #[test]
    fn top_n_global_with_single_group_level() {
        // Single group level + empty partition_by → the true GLOBAL path.
        // City sums: Paris=300, Lyon=150 → global top-1 = Paris 300.
        let spec = ReportSpec {
            group_by: vec!["city".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            top_n: Some(TopNFilter {
                n: 1,
                order_by: "total".into(),
                direction: "desc".into(),
                partition_by: Vec::new(),
            }),
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        assert_eq!(out.height(), 1);
        let total = out.column("total").unwrap().i64().unwrap().get(0).unwrap();
        assert_eq!(total, 300);
    }

    #[test]
    fn top_n_empty_partition_defaults_to_per_outer_group() {
        // Empty partition_by with a MULTI-level group_by → documented
        // fallback: top-N of the deepest dimension within each outer group.
        // group_by [city, plan] → top-1 plan per city = 2 rows
        // (Paris/B=200, Lyon/A=120).
        let spec = ReportSpec {
            group_by: vec!["city".into(), "plan".into()],
            aggregations: vec![agg("amount", AggFn::Sum, "total")],
            top_n: Some(TopNFilter {
                n: 1,
                order_by: "total".into(),
                direction: "desc".into(),
                partition_by: Vec::new(),
            }),
            ..Default::default()
        };
        let out = execute(&sample(), &spec).unwrap();
        assert_eq!(out.height(), 2, "top-1 plan per city");
    }
}
