---
name: rust-data-engine
description: >-
  Work RedPash's Rust `data` crate — the pure-compute dataframe engine built on Polars. Use this
  whenever loading/parsing files into a DataFrame, shaping data (filter / sort / group-by / aggregate /
  dedup / join / distinct / search / SQL), adding a cleaning step or a Report aggregation, crossing the
  JSON or wasm boundary, or anytime you're reaching for Polars `DataFrame` / `Series` / `Column` /
  `ChunkedArray` / `col()` / `AnyValue` / `LazyFrame` in Rust — even when the user just says "work with
  the dataframe", "parse this CSV in the engine", or names a data operation without saying "Polars". It
  encodes how the `data` crate is actually built (load → shape → emit, one engine for both the server and
  the in-browser wasm surface) so you extend the real patterns instead of inventing new ones.
compatibility: backend/crates/data (polars 0.54 via the doumouya/polars-rp fork; "lazy"/"csv"/"strings"/"dtype-full"/"regex"/"concat_str"/"sql" features)
---

# Rust data engine (the `data` crate)

> **Live companion doc — read it first / keep it open:**
> [`docs/internal/code/backend/data-engine.md`](../../../docs/internal/code/backend/data-engine.md) is the source of
> truth for the *current* engine surface (every cleaning `kind`, the `ReportSpec` pipeline, the canonical
> `FilterNode`, and the wasm `Workbook` method table). This skill teaches the Polars *idioms + discipline*;
> the doc carries the live API. When they disagree, **the code wins** (and the doc, not this skill, is what
> gets refreshed) — so point yourself at the doc rather than trusting any signature pinned here.

## What it is

`backend/crates/data` is RedPash's **pure-compute layer** — HTTP-agnostic, built on Polars. The `api` crate
calls these functions and serializes the results; tests exercise them directly. The *same* functions compile
twice: an **rlib** for the server and a **wasm cdylib** for the browser (`crate-type = ["cdylib","rlib"]`), so
"one engine, two surfaces" is literal — never fork the logic per surface. The purity is **enforced, not just
intended**: `sh tools/purity-check.sh` runs a `wasm32 cargo check` and gates every commit, so any io / http /
thread / time dependency that sneaks into `data` fails CI. That purity is the whole point — it is what lets a
page, a filtered window, a `score`, or a SQL result computed **in the browser** be byte-identical to the
server's for the same bytes, and the rows never leave the device.

Work it as **load → shape → emit**, and lean on the modules that already exist (lib.rs `pub mod` list):
`encoding`, `parse/` (dir), `dtype`, `sentinels`, `clean`, `distinct`, `joins`, `group_by`, `filter`,
`search`, `sort`, `sql`, `structure`, `steps/` (dir), `stats`, `view`, plus server-only `export` and the
wasm-only `wasm` shim — **reuse before you add**.

## 1 · Load — detect, then parse lazily

- `encoding` (chardetng) detects the byte encoding first; don't assume UTF-8 — a Latin-1 / UTF-16 CSV
  silently corrupts otherwise.
- `parse/` (`parse/mod.rs` + `parse/sniff.rs`) is the **upload front door**: `from_csv_bytes(bytes, tld)`
  decodes (locale-aware via the `tld` hint, e.g. `"fr"`), sniffs the dialect, and reads CSV via
  `CsvReadOptions` + `into_reader_with_file_handle` into a Polars **`LazyFrame`** (`.lazy()`) — the
  optimizer's projection/predicate **pushdown** prunes columns/rows before they materialize (pushdown, not
  Polars' separate *streaming engine*). It returns `(DataFrame, diag, encoding)`. **Default to lazy**; only
  `.collect()` to a `DataFrame` at the end. See [`references/expressions.md`](references/expressions.md).

## 2 · Shape — express with `col()`, collect once

Transformations are Polars **expressions** (`col("x").filter(...).sum()` etc.), assembled into a lazy plan
and `.collect()`ed once. The worked examples — read the matching module before writing a new transform:

- `group_by::execute(df, &ReportSpec)` — the Reports engine (pre-filter → combine keys → agg → collect →
  eager sort → top-N → windows). `AggFn` includes `q1`/`q3` (→ `quantile(lit(0.25/0.75), QuantileMethod::Linear)`).
- `filter::apply_filter(&df, &FilterNode)` — the **one** row-reducer, recursive over nested AND/OR groups,
  compiling the whole tree to **one** `Expr` and collecting once. `search` composes to the *same* `FilterNode`
  shape (an OR of `contains` across columns) — it is **not** a second filter engine.
- `sort::apply_sort`, `joins` (overlap scoring), `distinct`, `clean`, `structure`, and the `steps/` dispatch.

`steps::apply(df, kind, params)` is the cleaning-op switch: `kind` is **free-form text**, so a new clean op is
**one `match` arm with zero DB/DTO/route changes** (unknown kinds → a clean `DataError::InvalidSpec`). It
routes to `steps/{columns,rows,cells,structure}.rs`; `steps/util.rs` holds the **one** filter-predicate
compiler (`build_filter_predicate`, `pub(crate)`) reused by `crate::filter`. The expression + lazy-plan API
is in [`references/expressions.md`](references/expressions.md).

## 3 · Types — typed storage behind a type-erased handle

This is the crate's center of gravity and the part most worth understanding:

- A **`Column`** is what a `DataFrame` is made of in 0.54 (`df.columns() -> &[Column]`); reach the
  **`Series`** behind it with `.as_materialized_series()`, and the typed view by downcasting:
  `series.str()` / `.i64()` / `.f64()` → a `&StringChunked` / `&Int64Chunked` you can iterate. (A `Column`
  also exposes `.str()`/`.get(i)` directly for the common cases — the crate uses both.) This
  **type-erased-handle → downcast-to-typed** move is the same shape as the object registry
  (`AnyValue`/erased → concrete) — see the sibling skill `rust-object-registry-design`.
- **`AnyValue`** is the single type-erased *value* used to move a cell across a boundary without a per-type
  struct; **`DataType`** is the column's declared type (inference lives in `dtype`).
- The mechanism under all of it is `std::any` (`Any` + `downcast_ref`). Details + the
  `Column` / `Series` / `ChunkedArray<T>` surface: [`references/polars-types.md`](references/polars-types.md).

## 4 · Emit — cross the boundary as JSON

- To leave the engine, convert `AnyValue` → an owned value (the `cell` / av-to-owned pattern in `view.rs`)
  and serialize with **serde** — the server returns JSON; the wasm wrappers are a thin **JSON-in / JSON-out**
  shim over the *same* engine functions. The wire contract both surfaces speak is the **page shape**
  `{ columns, rows, total }` (`view::page` → `Page::to_json`), emitted identically server-side and in the
  browser. Structured data crosses as JSON, never as typed structs marshaled field-by-field.
  See [`references/boundary.md`](references/boundary.md).
- The wasm surface is a `#[wasm_bindgen]` **`Workbook`** (a CSV held resident in browser memory) plus one
  top-level `parse_score` fn — **not** a flat list of `parse_csv`/`apply_filter`/`auto_clean` wrappers. The
  `Workbook` methods (`from_csv`, `page`, `filter_page`, `view`, `score`, `sql`, `rows`, `cols`) each reuse
  the exact server function. The JS method list is **generated** from these exports, so there is no
  "exported-vs-wired" drift. See [`references/boundary.md`](references/boundary.md) and the live
  [`data-engine.md`](../../../docs/internal/code/backend/data-engine.md) §wasm for the full table.

## Discipline (why the boundaries are where they are)

- **Pure-compute only, enforced.** No HTTP, no DB, no Axum in this crate — the `api` crate owns that.
  `tools/purity-check.sh` (a `wasm32 cargo check`) is a commit gate, so a stray io/time/thread dep doesn't
  "feel wrong", it **fails CI**. Errors wrap into the crate's `DataError` for `api` to map to status codes.
- **wasm32 `cfg`-gating.** Anything whose deps don't compile to `wasm32-unknown-unknown` is
  `#[cfg(not(target_arch = "wasm32"))]`; the wasm shim is `#![cfg(target_arch = "wasm32")]`. The principled
  checklist of what won't cross (from the "Rust and WebAssembly" book): C/system-library bindings (no system
  libs in wasm), file/OS I/O, and threads/blocking. In lean that's exactly why **`export`** (→ the
  `rust_xlsxwriter` XLSX writer) is `#[cfg(not(target_arch = "wasm32"))]` and **server-only**, and why the
  `wasm` module is the only `target_arch = "wasm32"` one. (The polars-on-wasm story itself rides the
  **doumouya/polars-rp fork** — polars 0.54 made `polars-async` an unconditional `polars-core` dep that pulls
  tokio multi-thread + mio; the fork gates tokio off wasm. See backend/Cargo.toml + runbook 0023.) If you add
  a module, decide its surface and gate accordingly.
- **Reuse the module, don't reinvent.** A new transform almost always belongs in (or beside) an existing
  module; a new clean op is a `steps::apply` arm; a new row-reduction extends the **one** `FilterNode`.

## References

- [`references/polars-types.md`](references/polars-types.md) — the type model: `DataFrame` / `Column` /
  `Series` / `ChunkedArray<T>` / `SeriesTrait` / typed aliases (`StringChunked`, `UInt64Chunked`) /
  `AnyValue` / `DataType`, the 0.54 `Column`↔`Series` split, and `std::any` downcasting.
- [`references/expressions.md`](references/expressions.md) — `col()`, `Expr`, `LazyFrame`/`.lazy()`/`.collect()`,
  `SortMultipleOptions`, `QuantileMethod`, and the declare-then-collect lazy-plan pattern.
- [`references/boundary.md`](references/boundary.md) — `AnyValue` → owned → **serde** JSON; the page-shape
  wire contract; the wasm `Workbook` JSON-in/JSON-out shim; the pure-compute/HTTP-agnostic seam.
- [`references/supporting.md`](references/supporting.md) — the supporting std + crate APIs: `chrono`
  (datetimes), `Vec`, `Iterator`, `chardetng` (encoding), `rust_xlsxwriter` (server-only export).

## Related skills

- **`redpash-polars`** (if installed) — the polars 0.54 API surface RedPash actually uses, plus the
  version-specific footguns that bite *here* (the `Column`↔`Series` split, `CsvReadOptions`, `JoinArgs`,
  `SQLContext`, `AnyValue` cell matching, `StrptimeOptions`). Reach for it the moment you'd otherwise guess a
  polars signature; this skill is the *architecture*, that one is the *API*.
- **`rust-object-registry-design`** (repo, if installed) — the object/type model the engine serves; the
  type-erased `Column`/`Series`↔`ChunkedArray<T>` move here is the same "erased handle → concrete type"
  pattern that skill designs into the backend registry. Reach for it when *designing* types/storage rather
  than *working* the dataframe.
- The general **`rust`** skill — the idiomatic + compiler-as-oracle baseline (ownership, errors, the
  `cargo check/clippy/test` verify loop) that this skill assumes.
