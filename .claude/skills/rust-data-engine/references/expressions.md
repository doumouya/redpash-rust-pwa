# Expressions + the lazy plan — declare, then collect once

Polars work in the `data` crate is **declarative**: you build an expression plan with `col(...)`, chain it on a
`LazyFrame`, and `.collect()` exactly once at the end. The optimizer then prunes columns, pushes filters down,
and fuses the work. Eager `DataFrame` mutation is the exception, not the default.

> Polars is **0.54** here (doumouya/polars-rp fork). The expression DSL is stable across the 0.43→0.54 bump;
> the version-sensitive bits below — `SortMultipleOptions`, `QuantileMethod`, `CsvReadOptions` — are noted
> inline. When in doubt about a 0.54 signature, reach for the **`redpash-polars`** skill.

## `col()` — name a column in an expression
[docs.rs](https://docs.rs/polars/latest/polars/prelude/fn.col.html). The entry point to the expression DSL. An
`Expr` is a *recipe*, not a value:

```rust
use polars::prelude::*;
let out = lf
    .filter(col("status").eq(lit("active")))
    .group_by([col("company")])
    .agg([col("amount").sum().alias("total"), col("amount").count().alias("n")])
    .collect()?;          // <- the ONLY place work actually runs
```

Expressions compose (`col("x").fill_null(...).cast(DataType::Float64)`, `when().then().otherwise()`,
`.over([...])` for windows). The crate's `group_by::execute` (Reports), `steps/` (clean ops), `filter`, and
`joins` modules are the worked examples — read the matching one before writing a new transform.

## LazyFrame vs DataFrame — and why lazy wins
[`LazyFrame`] is a query plan; `DataFrame` is materialized rows. `parse` reads CSV via `CsvReadOptions` +
`into_reader_with_file_handle`, then `.lazy()` — so projection/predicate **pushdown** drops columns and rows
the plan discards before they materialize. The discipline:

- start lazy (`df.lazy()` or read lazily), express everything as `col()`/`Expr`,
- `.collect()` once to get the `DataFrame` you serialize,
- only go eager when an op genuinely needs materialized data (and then keep that window small).

Staying lazy through the chain is the established pattern, not an optimization to bolt on. (Precise term: this
is the optimizer's projection/predicate **pushdown**, not Polars' separate *streaming engine* — the crate uses
ordinary `.collect()`, not a streaming sink.)

## Sorting — `SortMultipleOptions` (0.54)
Sort options are `SortMultipleOptions`, with the descending flags set via builder methods:

```rust
// lazy, by expressions:
lf.sort_by_exprs(vec![col("total")],
    SortMultipleOptions::default().with_order_descending_multi(vec![true]))
// eager, by column names:
df.sort(["total"], SortMultipleOptions::default().with_order_descending_multi(vec![true]))?
```

`group_by::execute` deliberately **collects, then sorts the `DataFrame` eagerly** rather than chaining a lazy
`sort_by_exprs` off `group_by().agg()` — that chained-lazy sort has been observed to *silently drop* in some
Polars builds. (Top-N still uses lazy `sort_by_exprs` on a fresh plan; see `group_by.rs`.) When you add a sort,
copy the pattern in the module you're touching rather than re-deriving it.

## Aggregations + quantiles — `QuantileMethod` (0.54)
The agg surface is the prelude reductions: `sum`/`mean`/`min`/`max`/`first`/`last`/`median`/`count`/
`n_unique`/… The `AggFn` mapping lives in `group_by.rs`; the quantile aggs use **`QuantileMethod`** (renamed
from 0.43's `QuantileInterpolOptions`):

```rust
base.quantile(lit(0.25), QuantileMethod::Linear)   // q1   (group_by.rs)
base.quantile(lit(0.75), QuantileMethod::Linear)   // q3
```

Before hand-rolling a reduction, check the prelude — Polars almost certainly ships it, vectorized.

## CSV read internals
The crate's CSV entry point is `CsvReadOptions::default()…` + `.into_reader_with_file_handle(...)`
(`parse/mod.rs`, `parse/sniff.rs`) — the eager-options reader, then `.lazy()`. It does **not** use
`LazyCsvReader`. Reach for a lower-level reader only for a parsing concern the options API can't express
(custom chunking, dtype overrides mid-stream); otherwise stay on `CsvReadOptions`. (`from_csv_bytes` wraps all
of this: decode → sniff dialect → read → `(DataFrame, diag, encoding)`.)

## Rule of thumb

If you wrote a `for` loop over rows to transform data, stop — express it with `col()` on a `LazyFrame` and let
the optimizer + Arrow kernels do it. Per-row Rust loops are for *reading out* (typed `ChunkedArray<T>`
iteration at the boundary, e.g. `view::page` stringifying cells), not for transforming.
