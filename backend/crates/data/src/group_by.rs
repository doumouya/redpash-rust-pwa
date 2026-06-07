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
use shared::report::{AggFn, Aggregation, ReportSpec};

pub fn execute(df: &DataFrame, spec: &ReportSpec) -> Result<DataFrame> {
    // 1. Optional pre-filter via the same FilterNode tree the cleaner uses.
    let mut lf = df.clone().lazy();
    if let Some(v) = spec.filter.as_ref() {
        let json = serde_json::to_string(v).unwrap_or_default();
        if !json.is_empty() && json != "null" {
            let filtered = crate::parse::apply_filter(df.clone(), &json)?;
            lf = filtered.lazy();
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
                    agg.over(parts)
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
                    inner.over(parts).alias(w.alias.as_str())
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
            AggFn::Q1 => base.quantile(lit(0.25), QuantileInterpolOptions::Linear),
            AggFn::Q3 => base.quantile(lit(0.75), QuantileInterpolOptions::Linear),
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
