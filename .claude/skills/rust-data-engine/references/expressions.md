# Expressions + the lazy plan — declare, then collect once

Polars work in the `data` crate is **declarative**: you build an expression plan with `col(...)`, chain it on a
`LazyFrame`, and `.collect()` exactly once at the end. The optimizer then prunes columns, pushes filters down, and
fuses the work. Eager `DataFrame` mutation is the exception, not the default.

## `col()` — name a column in an expression
[docs.rs](https://docs.rs/polars/latest/polars/prelude/fn.col.html). The entry point to the expression DSL
(`~35×` in the crate). An `Expr` is a *recipe*, not a value:

```rust
use polars::prelude::*;
let out = lf
    .filter(col("status").eq(lit("active")))
    .group_by([col("company")])
    .agg([col("amount").sum().alias("total"), col("amount").count().alias("n")])
    .sort(["total"], SortMultipleOptions::default())
    .collect()?;          // <- the ONLY place work actually runs
```

Expressions compose (`col("x").fill_null(...).cast(DataType::Float64)`, `when().then().otherwise()`, `.over([...])`
for windows). The crate's `group_by` (Reports), `steps`, and `joins` modules are the worked examples — read the
matching one before writing a new transform.

## LazyFrame vs DataFrame — and why lazy wins
[`LazyFrame`] is a query plan; `DataFrame` is materialized rows. `parse` reads CSV via `CsvReadOptions` +
`into_reader_with_file_handle`, then `.lazy()` — so projection/predicate **pushdown** drops columns and rows the
plan discards before they materialize. The discipline:

- start lazy (`df.lazy()` or read lazily), express everything as `col()`/`Expr`,
- `.collect()` once to get the `DataFrame` you serialize,
- only go eager when an op genuinely needs materialized data (and then keep that window small).

`.lazy()` appears `~22×` and `.collect()` `~122×` — staying lazy through the chain is the established pattern, not
an optimization to bolt on. (Precise term: this is the optimizer's projection/predicate **pushdown**, not Polars'
separate *streaming engine* — the crate uses ordinary `.collect()`, not a streaming sink.)

## `mode` and the op surface
[docs.rs `mode`](https://docs.rs/polars/latest/polars/prelude/mode/index.html) — the statistical mode of a Series;
an *illustrative* stand-in (the crate doesn't call `mode` itself) for the many ready-made ops it does use
(`sum`/`mean`/`median`/`n_unique`/`value_counts`/`is_duplicated`/…). Before hand-rolling a reduction, check the
prelude — Polars almost certainly ships it, vectorized.

## CSV read internals
The crate's CSV entry point is `CsvReadOptions::default()…` + `.into_reader_with_file_handle(...)`
(`parse/mod.rs`, `parse/sniff.rs`) — the eager-options reader, then `.lazy()`. It does **not** use `LazyCsvReader`
(0× in `src`). Reach for a lower-level reader only for a parsing concern the options API can't express (custom
chunking, dtype overrides mid-stream); otherwise stay on `CsvReadOptions`.

## Rule of thumb

If you wrote a `for` loop over rows to transform data, stop — express it with `col()` on a `LazyFrame` and let the
optimizer + Arrow kernels do it. Per-row Rust loops are for *reading out* (typed `ChunkedArray<T>` iteration at the
boundary), not for transforming.
