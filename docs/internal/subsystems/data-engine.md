---
title: Data engine — the `data` crate
section: Internal
order: 23
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Data engine — the `data` crate

`backend/crates/data/` is RedPash's compute layer. Everything that
touches a row, a byte buffer, or a Polars frame lives here so the
`api` crate stays small and focused on HTTP plumbing.

It is **HTTP-agnostic by construction.** Tests exercise these
functions directly without spinning up a server. Every byte enters
as a buffer the caller supplies; every result exits as a typed
struct or a `DataFrame`. No `tokio::fs`, no `sqlx`, no `reqwest`.
This is what bought WASM-readiness for free — see
[wasm-engine](wasm-engine.md) for the runtime swap.

Source of truth: `backend/crates/data/src/lib.rs`.

## The crate's modules

```
encoding   — detect text encoding from a byte buffer (chardetng)
parse      — streaming CSV / XLSX / JSON → DataFrame; query-time filter helper
dtype      — per-column type inference + light per-column stats
dedup      — full-row + per-PK duplicate detection
joins      — detect join keys via set-overlap scoring
group_by   — aggregation engine (used by Reports + the redtable's GROUP)
steps      — apply / undo / redo a `project_steps` op  (see step-engine.md)
stats      — file-level summary numbers (rows, cols, dtype mix, …)
clean      — auto_clean: trim whitespace, blank junk, drop duplicates
export     — DataFrame → CSV / XLSX / JSON output bytes
render     — Markdown → HTML for /docs, Maud report templates  (server-only;
              gated out of wasm32 — see lib.rs lines 30-35)
wasm       — wasm-bindgen wrappers (wasm32 only — see wasm-engine.md)
```

Module choice when adding a new operation:

- Touches a single column's values? → `steps` (it's a cleaning step).
- Touches multiple columns / produces aggregates? → `steps` or
  `group_by` depending on whether the result is the same shape
  (step) or a reduction (group_by).
- Reads bytes, produces a DataFrame? → `parse`.
- Writes bytes, consumes a DataFrame? → `export`.
- Walks rows for a stat / classification but doesn't mutate? →
  `dtype` (per-column) or `stats` (per-frame) or `dedup` / `joins`
  for their specific purposes.
- Does HTML rendering / Markdown / syntax highlighting? → `render`.
  Anything else, *not* `render` — keep the wasm-callable surface
  free of doc-render deps.

## DataFrame is the universal currency

`polars::prelude::DataFrame` is the in-memory shape every module
takes and returns. The `api` crate hydrates a frame once per file
(see `routes::files::hydrate`) by:

1. Reading bytes from `REDPASH_DATA_DIR/files/<rid>.bin`.
2. Running them through `data::parse::*`.
3. Replaying every applied `project_steps` row in `ordinal` order
   via `data::steps::replay`.

The result is cached on `AppState` (a `DashMap` keyed by file RID)
so subsequent `/api/files/:rid/page` reads don't re-parse + re-replay.
Invalidation happens on any step apply / undo / redo.

See [step-apply-and-replay](../flows/step-apply-and-replay.md) for
the full trace.

## Error type

`data::DataError` is the crate-level error. The `api` crate maps it
to HTTP status codes:

```rust
pub enum DataError {
    Io(#[from] std::io::Error),
    Polars(#[from] polars::error::PolarsError),
    Encoding(String),
    InvalidSpec(String),   // bad step params, malformed filter, …
    NotFound(String),
    Export(String),
}
```

`InvalidSpec` is the load-bearing one: it carries a human message
the API surfaces as `kind="invalid_spec"`. Use it for "the input was
syntactically OK but semantically wrong" — bad column reference, bad
op, array-where-scalar-expected, etc.

## The encoding pipeline

`data::encoding::detect(bytes)` runs `chardetng` against a sample
of the buffer and returns `("utf-8" | "windows-1252" | …,
confidence)`. `data::parse` consumes the result so a Latin-1 CSV
with `€` characters doesn't land as mojibake.

The encoding is persisted on `project_files.encoding` so reads
don't redetect. `POST /api/files/:rid/encoding` lets the user
override the detected value when the demo gets it wrong.

## The parse path

`data::parse` accepts:

- **CSV** — default; delimiter sniffing per the file's first
  record, fallback to `,`.
- **XLSX** via `calamine` — one DataFrame per sheet; caller picks,
  default first non-empty.
- **JSON** — array of objects → columns named from the first object's
  keys; arrays of arrays not yet supported.

The hard case the parser invests effort in: **wrapped CSV** — files
where the entire row is double-quoted at the outer level, with
internal quotes escaped as `""`. Polars' default parse collapses
those to one column; `data::parse::unwrap_csv_string` (and the
`unwrap_csv` step that calls it) peels the outer wrap row-by-row,
sniffing the inner delimiter per record (since wrapping is often
inconsistent across rows in the wild).

`data::parse::apply_filter(df, filter_json)` is the query-time
filter the `/api/files/:rid/page` endpoint uses for sort/filter/search
on the redtable. Predicate-builder shape: [filter-dto](../specs/filter-dto.md).

## The cleaning pipeline

`data::clean::auto_clean(df)` is the always-safe transform that
runs on import:

1. Trim leading/trailing whitespace on every string column.
2. Blank junk placeholders (`""`, `"NA"`, `"N/A"`, `"null"`, `"-"`,
   `"—"`, …) to real nulls — see the sentinel set below.
3. Drop fully-identical duplicate rows (stable — first occurrence
   wins).

Returns `(DataFrame, CleanSummary)` so the demo + import UI can
show "47 cells trimmed, 12 junk-blanked, 3 duplicates dropped"
honestly. On wasm32, step 3's dedup runs through a non-rayon serial
implementation — see [wasm-engine](wasm-engine.md).

User-initiated cleaning is the step engine — the catalog at
[step-engine](step-engine.md) covers the 17 user-facing kinds
(filter_rows, drop_columns, set_cell, fill_nulls, replace_text, …).

### Sentinels — global + per-user

A sentinel is a string the auto-clean blanks to NULL. Two layers:

- **Global sentinels** — the canonical RedPash vocabulary
  (defined in `data::clean::SENTINELS`). Promoted from
  `sentinel_submissions` once ≥2 users have submitted the same
  canonical value (per [orphan-prefs runbook](../runbooks/0001-orphan-prefs.md)
  for the historical context).
- **Per-user `learned_sentinels`** — a list stored in
  `user_preferences` (key=`learned_sentinels`, value is a JSON
  array). `GET /api/me` merges this with the global set and
  returns it as `global_sentinels` for the Cleaner's Fix-invalid
  modal. Writes flow through `PATCH /api/me/prefs`; the
  share-sentinels gate fires when `share_sentinels=true` and
  mirrors new entries to the shared `sentinel_submissions` table.

See [prefs](prefs.md) for the table + the gate.

## dtype + stats — per-column intelligence

Every column carries a `ColumnMeta` cached on
`project_files.columns_meta` JSONB. Computed by
`data::dtype::summarize`:

- `dtype` — storage dtype (what Polars actually parsed it as: int /
  float / date / bool / string / empty).
- `semantic_dtype` — sniffed *intended* dtype from a sample of
  values (the messy `prix_ht` column with `€1234,56` cells stays
  `string` storage but sniffs `float` semantic).
- `null_pct` — fraction null.
- `unique_pct` — fraction unique.
- `sample` — one representative cell value.

The pair `(dtype, semantic_dtype)` drives
`data::stats::cleanness_pct`: a string-stored, float-intended
column gets docked proportionally to how many values fail a strict
native parse. That's exactly the dirt the cleaner pipeline is
built to fix (`cast`, `replace_text`, `fix_invalid`).

## dedup + joins — set-based detection

- `data::dedup::full_row_duplicates(df)` — returns row indices
  that duplicate an earlier row. Used by the workspace's dedup
  tool + `GET /api/files/:rid/dedup`.
- `data::dedup::per_key_duplicates(df, key_cols)` — PK-mode: rows
  sharing the same key tuple. The columns picker writes a
  multi-column key spec.
- `data::joins::detect_join_keys(df_a, df_b)` — set-overlap
  scoring on every (col_a, col_b) pair across two frames, returning
  a ranked list of candidates with overlap %. Powers the join
  builder in the workspace.

## group_by — aggregation for Reports

`data::group_by::aggregate(df, spec)` takes a `GroupSpec` (group
columns + aggregations) and returns a reduced DataFrame. The spec
shape mirrors the Reports page's group panel:

```rust
GroupSpec {
    by:   Vec<String>,    // group columns
    aggs: Vec<AggSpec>,   // one per output column
}
AggSpec {
    column: String,                                      // source
    agg:    "sum" | "mean" | "min" | "max" | "count" |
            "first" | "last" | …,
    alias:  Option<String>,                              // output column name
}
```

Same engine the Reports preview UI calls. When charts compile to a
data spec, the same `GroupSpec` flows from chart-config → engine →
result.

## export — going back out

`data::export::to_csv(df, opts) -> Vec<u8>` and `to_xlsx(df)`
produce the bytes for the file export path. Both respect the
caller's currently-applied filter (the `?filters=` query param
flows through `parse::apply_filter` before export hits).

## Polars feature matrix

Server build (`backend/Cargo.toml`):

```
polars = { version = "0.43",
           features = ["lazy", "csv", "strings", "dtype-full",
                       "regex", "concat_str"] }
```

Default features (`fmt`, `temporal`, …) come along on the server —
the `fmt` default is what gives `DataFrame: Debug` its pretty-print
in tracing output.

Wasm32 build (`backend/crates/data/Cargo.toml`, the
target-specific block):

```
polars = { version = "0.43", default-features = false,
           features = ["lazy", "csv", "strings", "dtype-full",
                       "regex", "concat_str"] }
```

`default-features = false` is load-bearing — the `fmt` default
pulls `comfy-table → crossterm` (terminal IO), which doesn't
compile on `wasm32-unknown-unknown`. The six explicit features are
the same set the server uses (parser + lazy frame + string ops +
extended dtypes), so behavior is parity across runtimes.

See [wasm-engine](wasm-engine.md) §1 for the full cliff (every
transitive dep that had to be gated to make the wasm build pass).

## What lives where vs what's open to grow

| Concern | Current location | Open to grow? |
|---|---|---|
| New cleaning op | `steps::apply` match arm | Yes — see [step-engine](step-engine.md) |
| New parse source (Parquet, etc.) | `parse.rs` module | Yes — add a new entry point + delimit by file_type |
| New stat / column metric | `dtype::summarize` | Yes if per-column; new module if cross-column |
| New aggregation | `group_by` | Yes |
| New export format | `export.rs` | Yes |
| Server-side rendering (Markdown, Maud) | `render.rs` | Yes but **not on the wasm-callable path** (gated out of wasm32 in lib.rs) |
| Anything that needs HTTP / DB / FS | not here — belongs in `api` | No |

## Cross-cuts

- **DataFrames are not async.** Everything in `data` is sync. The
  `api` crate's handlers are async; they call data crate functions
  inside the await boundary. Long compute holds a tokio runtime
  thread — fine at solo-dev scale; revisit with `spawn_blocking`
  if individual files push into hundreds of MB.
- **No HTTP types in here.** `DataError → AppError` mapping happens
  in `api`. Don't import `axum` from `data`.
- **WASM-safe path.** Everything except `render.rs` compiles for
  `wasm32-unknown-unknown` per the cfg gate. New modules should
  follow that property by default; if you reach for a non-wasm
  crate, gate it the same way and document why in
  [wasm-engine](wasm-engine.md).
