# Supporting APIs — the std + crate cast around the engine

These aren't the engine, but you'll use them constantly inside it. Each entry: what it's for in the `data`
crate and the canonical doc.

## Iterator — how you read typed data out
[core::iter::Iterator](https://doc.rust-lang.org/nightly/core/iter/trait.Iterator.html). The trait behind every
`ChunkedArray<T>` read: `s.i64()?.into_iter()` yields `Option<i64>` (the `Option` is the null), and you `map` /
`filter` / `collect` from there. The boundary pattern is `iter → map(cell/av-to-owned) → collect::<Vec<_>>()`
(see `view::page`). Reach for `Iterator` to **read out** at the edge — not to transform (that's `col()`
expressions; see `expressions.md`). Useful adaptors here: `filter_map`, `enumerate`, `zip`, `collect()` (into
`Vec`, `String`, or back into a `ChunkedArray`).

## Vec — the ubiquitous owned collection
[alloc::vec::Vec](https://doc.rust-lang.org/nightly/alloc/vec/struct.Vec.html). A `DataFrame` is built from a
`Vec<Column>` (via `DataFrame::new_infer_height(vec![…])`); a page's rows are a `Vec<Vec<Option<String>>>`;
column values collect into `Vec<Option<T>>`. Nothing exotic — just know it's the staging container on both
sides of the JSON boundary, and prefer `Vec::with_capacity(n)` when the size is known (the crate does this when
building rows in `view::page` and series elsewhere).

## chrono — datetimes
[docs.rs/chrono](https://docs.rs/chrono/latest/chrono/) (a workspace dep of the `data` crate). The datetime
layer behind the `Date`/`Datetime(_, _)` `DataType`s, the `dtype` module's date detection, and the
`format_dates` / `cast`-to-date clean ops. `NaiveDate`/`NaiveDateTime`/`DateTime<Tz>` for parsing + formatting;
pair with the cleanness report's drift detection ("value looks like a date but the column is typed string").
Format dates **readably on the wire** — the engine stores them typed, the boundary presents them.

## chardetng — byte-encoding detection
The `encoding` module's engine: sniff the byte buffer's encoding before parsing, then decode to UTF-8 for
Polars. Don't assume UTF-8 on upload — a Latin-1 / UTF-16 CSV silently corrupts otherwise. This is step 0 of
**Load** (see SKILL.md §1): detect → decode (locale-aware via the `tld` hint) → sniff dialect → read. It is
wired into `parse::from_csv_bytes`, which returns the detected `encoding` alongside the frame so the boundary
can report it.

## rust_xlsxwriter — the server-only export writer
[docs.rs/rust_xlsxwriter](https://docs.rs/rust_xlsxwriter/latest/rust_xlsxwriter/). Powers `export::to_xlsx`
(single-sheet Excel 2007), alongside CSV + JSON exporters in `export.rs`. It **does not build on
`wasm32`**, so the whole `export` module is `#[cfg(not(target_arch = "wasm32"))]` and **server-only** — the
canonical example of the wasm32 cfg-gating discipline (see SKILL.md §Discipline + the purity gate). The export
path writes each `AnyValue` into a cell keeping its native type (`write_cell`), the typed twin of the
boundary's `cell` stringifier.

## Rule of thumb

`Iterator` + `Vec` are the **edges** (read out, stage for JSON); `chrono`/`chardetng` are **typed concerns**
(dates, encoding) that bracket the Polars core; `rust_xlsxwriter` is a **server-only emit** path. The middle —
the actual shaping — stays in `col()` expressions on a `LazyFrame`.
