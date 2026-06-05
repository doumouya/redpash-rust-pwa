---
name: rust-data-engine
description: >-
  Work RedPash's Rust `data` crate — the pure-compute dataframe engine built on Polars. Use this
  whenever loading/parsing files into a DataFrame, shaping data (filter / sort / group-by / aggregate /
  dedup / join / distinct), inferring or converting column types, adding a cleaning step or a Report
  aggregation, crossing the JSON or wasm boundary, or anytime you're reaching for Polars `DataFrame` /
  `Series` / `ChunkedArray` / `col()` / `AnyValue` / `LazyFrame` in Rust — even when the user just says
  "work with the dataframe", "parse this CSV in the engine", or names a data operation without saying
  "Polars". It encodes how the `data` crate is actually built (load → shape → emit, one engine for both
  the server and the in-browser wasm surface) so you extend the real patterns instead of inventing new ones.
compatibility: backend/crates/data (polars 0.43, "lazy"/"csv"/"strings"/"dtype-full" features)
---

# Rust data engine (the `data` crate)

## What it is

`backend/crates/data` is RedPash's **pure-compute layer** — HTTP-agnostic, built on Polars. The `api` crate
calls these functions and serializes the results; tests exercise them directly. The *same* functions compile
twice: an **rlib** for the server and a **wasm cdylib** for the browser (`crate-type = ["cdylib","rlib"]`), so
"one engine, two surfaces" is literal — never fork the logic per surface.

Work it as **load → shape → emit**, and lean on the modules that already exist
(`encoding`, `parse`, `dtype`, `dedup`, `distinct`, `joins`, `group_by`, `steps`, `stats`, `clean`, `export`) —
reuse before you add.

## 1 · Load — detect, then parse lazily

- `encoding` (chardetng) detects the byte encoding first; don't assume UTF-8.
- `parse` reads CSV (via `CsvReadOptions` + `into_reader_with_file_handle`) through a Polars **`LazyFrame`**
  (`.lazy()` ~22×) — the optimizer's projection/predicate **pushdown** prunes columns/rows before they materialize
  (pushdown, not Polars' separate *streaming engine*). **Default to lazy**; only `.collect()` to a `DataFrame` at
  the end. See [`references/expressions.md`](references/expressions.md).

## 2 · Shape — express with `col()`, collect once

Transformations are Polars **expressions** (`col("x").filter(...).sum()` etc., ~35× in the crate), assembled into
a lazy plan and `.collect()`ed once. `group_by` (Reports), `dedup`/`distinct`, `joins` (overlap scoring), and
`steps` (apply/undo/redo of a `project_steps` op) are the worked examples — read the matching module before
writing a new transform. The expression + lazy-plan API is in [`references/expressions.md`](references/expressions.md).

## 3 · Types — typed storage behind a type-erased handle

This is the crate's center of gravity (`DataType` ~62×, `AnyValue` ~72×) and the part most worth understanding:

- A **`Series`** is a type-erased column (a `dyn SeriesTrait` over a concrete `ChunkedArray<T>`).
- Get the typed view by downcasting: `series.str()` / `.i64()` / `.f64()` → a `&StringChunked` / `&Int64Chunked`
  you can iterate. This **type-erased-handle → downcast-to-typed** move is the same shape as the object registry
  (`AnyValue`/`Object` → concrete) — see the sibling skill `rust-object-registry-design`.
- **`AnyValue`** is the single type-erased *value* used to move a cell across a boundary without a per-type struct;
  **`DataType`** is the column's declared type (inference lives in `dtype`).
- The mechanism under all of it is `std::any` (`Any` + `downcast_ref`). Details +
  the `ChunkedArray<T>` / `SeriesTrait` surface: [`references/polars-types.md`](references/polars-types.md).

## 4 · Emit — cross the boundary as JSON

- To leave the engine, convert `AnyValue` → an owned value (the `av_to_owned` pattern) and serialize with
  **serde** — the server returns JSON; the wasm wrappers (`wasm.rs`'s 7 `#[wasm_bindgen]` exports — `parse_csv`,
  `apply_filter`, `auto_clean`, … each `-> Result<String, JsValue>`) are a thin **JSON-in / JSON-out** shim over
  the *same* engine functions. Structured data crosses as JSON, never as typed structs marshaled field-by-field.
  See [`references/boundary.md`](references/boundary.md).

## Discipline (why the boundaries are where they are)

- **Pure-compute only.** No HTTP, no DB in this crate — the `api` crate owns that. Keeps the engine testable +
  wasm-compilable. Errors wrap into the crate's `Error` for `api` to map to status codes.
- **wasm32 `cfg`-gating.** Anything whose deps don't compile to `wasm32-unknown-unknown` is
  `#[cfg(not(target_arch = "wasm32"))]`; the wasm wrappers are `#[cfg(target_arch = "wasm32")]`. The principled
  checklist of what won't cross (from the "Rust and WebAssembly" book): C/system-library bindings (no system libs
  in wasm), file/OS I/O, and threads/blocking — which is exactly why `render` (→ `onig_sys`/`crossterm`) is gated
  out. If you add a module, decide its surface and gate accordingly.
- **Reuse the module, don't reinvent.** A new transform almost always belongs in (or beside) an existing module.

## References

- [`references/polars-types.md`](references/polars-types.md) — the type model: `DataFrame` / `Series` /
  `ChunkedArray<T>` / `SeriesTrait` / typed aliases (`StringChunked`, `UInt64Chunked`) / `AnyValue` / `DataType`,
  and `std::any` downcasting.
- [`references/expressions.md`](references/expressions.md) — `col()`, `Expr`, `LazyFrame`/`.lazy()`/`.collect()`,
  `mode` and other ops; the declare-then-collect lazy-plan pattern.
- [`references/boundary.md`](references/boundary.md) — `AnyValue` → owned → **serde** JSON; the wasm cdylib
  JSON-in/JSON-out shim; the pure-compute/HTTP-agnostic seam.
- [`references/supporting.md`](references/supporting.md) — the supporting std + crate APIs: `chrono` (datetimes),
  `ndarray` (n-dim numerics), `Vec`, `Iterator`, `chardetng` (encoding).

## Related skills

- **`rust-object-registry-design`** (repo) — the object/type model the engine serves; the type-erased
  `Series`↔`ChunkedArray<T>` move here is the same "erased handle → concrete type" pattern that skill designs into
  the backend registry. Reach for it when *designing* types/storage rather than *working* the dataframe.
- The general **`rust`** skill (if installed) — the idiomatic + compiler-as-oracle baseline (ownership, errors,
  the `cargo check/clippy/test` verify loop) that this skill assumes.
