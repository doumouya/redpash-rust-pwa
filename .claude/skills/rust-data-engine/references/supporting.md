# Supporting APIs — the std + crate cast around the engine

These aren't the engine, but you'll use them constantly inside it. Each entry: what it's for in the `data` crate
and the canonical doc.

## Iterator — how you read typed data out
[core::iter::Iterator](https://doc.rust-lang.org/nightly/core/iter/trait.Iterator.html). The trait behind every
`ChunkedArray<T>` read: `s.i64()?.into_iter()` yields `Option<i64>` (the `Option` is the null), and you `map` /
`filter` / `collect` from there. The boundary pattern is `iter → map(av_to_owned) → collect::<Vec<_>>()`. Reach
for `Iterator` to **read out** at the edge — not to transform (that's `col()` expressions; see `expressions.md`).
Useful adaptors here: `filter_map`, `enumerate`, `zip`, `collect()` (into `Vec`, `String`, or back into a
`ChunkedArray`).

## Vec — the ubiquitous owned collection
[alloc::vec::Vec](https://doc.rust-lang.org/nightly/alloc/vec/struct.Vec.html). Rows arrive/leave as
`Vec<serde_json::Map<String, Value>>`; a `DataFrame` is built from a `Vec<Series>`; column values collect into
`Vec<Option<T>>`. Nothing exotic — just know it's the staging container on both sides of the JSON boundary, and
prefer `Vec::with_capacity(n)` when the size is known (the crate does this when building series).

## chrono — datetimes
[docs.rs/chrono](https://docs.rs/chrono/latest/chrono/). The datetime layer behind the `Datetime`/`Date`
`DataType`s and the `dtype` module's date detection. `NaiveDate`/`NaiveDateTime`/`DateTime<Tz>` for parsing +
formatting; pair with the validator's drift detector ("value looks like a date but the column is typed string").
Format dates **readably on the wire** (e.g. `MMM dd, yyyy` style) — the engine stores them typed, the boundary
presents them.

## ndarray — n-dimensional numerics
[docs.rs/ndarray](https://docs.rs/ndarray/latest/ndarray/). For matrix / multi-axis numeric work that Polars'
column model doesn't express directly. Polars can hand off via `DataFrame::to_ndarray` (numeric frames) when you
need linear-algebra-shaped operations; convert back to columns to re-enter the engine. Use it only when the work
is genuinely 2-D/N-D numeric — most data shaping stays in expressions.

## chardetng — byte-encoding detection
The `encoding` module's engine: sniff the byte buffer's encoding before parsing, then decode to UTF-8 for Polars.
Don't assume UTF-8 on upload — a Latin-1 / UTF-16 CSV silently corrupts otherwise. This is step 0 of **Load** (see
SKILL.md §1): detect → decode → `LazyFrame`.

## Rule of thumb

`Iterator` + `Vec` are the **edges** (read out, stage for JSON); `chrono`/`ndarray`/`chardetng` are **typed
concerns** (dates, numerics, encoding) that bracket the Polars core. The middle — the actual shaping — stays in
`col()` expressions on a `LazyFrame`.
