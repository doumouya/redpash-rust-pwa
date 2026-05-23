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

## Rust internals — algorithm + tuning per module

Reference depth for engineering planning + optimization. Each
module's algorithm, the constants that gate its behavior, the
allocation pattern, and the decision points where a future
optimization would land.

### `encoding` — BOM-first, chardetng-second

```rust
pub fn detect(bytes: &[u8], tld: Option<&str>) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { return "utf-8".into(); }
    if bytes.starts_with(&[0xFF, 0xFE])       { return "utf-16le".into(); }
    if bytes.starts_with(&[0xFE, 0xFF])       { return "utf-16be".into(); }
    let mut det = EncodingDetector::new();
    det.feed(bytes, true);
    det.guess(/* tld hint */, /* allow_utf8 */ true).name().to_ascii_lowercase()
}
```

- **BOM short-circuit** — saves chardetng's whole-buffer scan when
  the BOM is present (UTF-8/16 case). The vast majority of modern
  uploads hit this path.
- **`chardetng` is Mozilla's detector** — same algorithm Firefox
  ships; tested against the wild-CSV corpus. No tunable
  parameters; it walks the buffer once.
- **Hot path cost**: O(n) over the byte buffer. For a 256 MiB
  upload that's the dominant pre-parse cost (~50-100ms on the
  dev machine).
- **Decode helper** (`encoding::decode`) returns
  `(decoded_text, enc_name)` in one call. Uses `encoding_rs`'s
  `Cow`-based decoder — zero-copy when the bytes are valid UTF-8.
- **Optimization target**: chardetng `feed(bytes, last=true)` does
  the full scan synchronously. If a future endpoint streams a
  multi-GB CSV, switch to incremental `feed`/`guess` per chunk.

### `parse` — CSV/XLSX/JSON → DataFrame

Per-format strategy:

**CSV** — `polars::io::CsvReader` with delimiter sniffing.
Sniffer logic: count `,`, `;`, `\t`, `|` in the first record; pick
the most-frequent. Fallback to `,` when all four tie at zero. This
runs *before* `CsvReader` so we pass the delimiter as a parse
option — Polars' own sniffing is less aggressive about non-comma
delimiters in non-English CSVs.

**XLSX** — `calamine::open_workbook_auto_from_rs(&bytes[..])`.
First non-empty sheet wins by default; caller can pass a sheet
name. Calamine **deserializes the whole workbook in memory** — no
streaming. A 256 MiB xlsx becomes ~256 MiB resident; that's the
load case for the `xlsx_to_csv` wrapped in `tokio::task::spawn_blocking`
on the upload route. After convert, the bytes path is identical to
CSV.

**JSON** — array-of-objects only. Walks the first object's keys
once to build the column set; iterates remaining objects pulling
values per column. Missing keys become NULL in that row. Arrays-
of-arrays not supported.

**`unwrap_csv_string`** — the hardest case. Handles "wrapped CSV"
where rows arrived with the *whole record* quoted and internal
quotes escaped as `""`:

```
row 1: "name,email"
row 2: "Alice,a@e.com"
row 3: "Bob,b@e.com"
```

becomes after unwrap:

```
name,email
Alice,a@e.com
Bob,b@e.com
```

**Per-row defensiveness**:

```rust
fn defensive_unquote(s: &str) -> String {
    let t = s.trim();
    let inner = if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        &t[1..t.len() - 1]
    } else {
        t  // some rows in the wild miss their wrap entirely
    };
    inner.replace("\"\"", "\"")
}

fn sniff_delim(record: &str) -> u8 {
    const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];
    DELIMS.iter()
        .map(|&d| (d, record.bytes().filter(|&b| b == d).count()))
        .filter(|&(_, n)| n > 0)
        .max_by_key(|&(_, n)| n)
        .map(|(d, _)| d).unwrap_or(b',')
}
```

Inner delimiter is sniffed **per-row** (not once for the whole
file) because wild wrapped CSVs are inconsistent — different rows
use `,` / `;` / `|`. The fleury fixture `raw_dossier_onecol_tricky`
exercises exactly this; it grew the regression test 178-rows count
in `tests/`.

**`apply_filter`** — the query-time predicate. Walks the
`FilterNode` tree, builds a `polars::Expr` via
`data::parse::filter_expr` per leaf, reduces groups with `and()` /
`or()`. Case-insensitive by default ([filter-dto](../specs/filter-dto.md)
§case_sensitive); flips to case-sensitive when the wire flag is
explicitly `true`.

Allocation: builds two columns per string op — `str_col` (lowercased
or not) and `val_op()` (RHS in matching case). Both are
`polars::Expr` builders — cheap, no DataFrame materialization until
`collect()` is called downstream.

### `dtype` — sniff + summarize

```rust
pub fn summarize(s: &Series) -> ColumnMeta {
    let stored_dtype = polars_dtype_to_str(s.dtype());
    let semantic_dtype = sniff(s.head(Some(SAMPLE_SIZE)));
    let null_pct = s.null_count() as f32 / s.len() as f32;
    let unique_pct = s.n_unique().ok().unwrap_or(0) as f32 / s.len() as f32;
    let sample = s.iter().find(|v| !v.is_null()).map(|v| v.to_string());
    ColumnMeta { name: s.name().to_string(), dtype: stored_dtype,
                 semantic_dtype, null_pct, unique_pct, sample }
}
```

**Tuning**:

- `SAMPLE_SIZE = 100` (top of file) — number of non-null values
  passed to the sniff. Smaller misses tail rarities; larger
  doesn't change the call (post-100 values rarely change the
  inferred semantic). Profiled at this size.
- **Sniff rules** (in order): try `i64` parse → try `f64` parse
  → try ISO date parse (`YYYY-MM-DD`) → try `bool` parse
  (`true|false|0|1` after lowercase trim) → fall back to
  `string`. First non-empty wins; the column doesn't have to be
  100% homogeneous to sniff a type — `dtype::IS_NUMERIC_THRESHOLD
  = 0.8` (80%) gates the call.
- **`unique_pct` is O(n log n)**. Polars uses `n_unique()` which
  hashes-and-counts; cheap on a single-column scan. The
  `summarize` for-loop runs once per column at hydrate time.

### `dedup` — full-row and per-key

**`full_row_duplicates(df) -> Vec<u32>`** — returns *indices* of
rows that duplicate an earlier row (the duplicate, not the
original):

```rust
let mut seen: HashSet<u64> = HashSet::with_capacity(df.height());
let mut dups: Vec<u32> = Vec::new();
for i in 0..df.height() {
    let row_hash = hash_row(df, i);  // u64 — fxhash of every cell's bytes
    if !seen.insert(row_hash) {
        dups.push(i as u32);
    }
}
```

Hash collision risk: at 4M unique rows, FxHash's 64-bit space gives
P(collision) ≈ 4×10⁻¹² — negligible. Switch to `(u64, u64)` if a
future workload hits hundreds of millions of rows.

**`per_key_duplicates(df, key_cols)`** — groupby on the key
columns, return any group with `count > 1`. Polars `lazy().groupby(key).agg(count).filter(count > 1)`.
Faster than full-row hashing when the key is narrow.

### `joins::detect_join_keys` — overlap coefficient

Already documented in [docs/features/joins.md](../../features/joins.md) at full
algorithm depth. Highlights:

- `MAX_UNIQUE = 5000` per column per file — the cap that bounds
  the unique-value HashSets. Above this, the join detector is
  fishing in noise; the search would still return useful pairs
  but at a steep cost.
- **Score**: `|A ∩ B| / min(|A|, |B|)` — overlap coefficient, not
  Jaccard. Favors FK→PK relationships over Jaccard which
  penalizes asymmetric sizes (a 50-row table's PK won't score
  well against a 5000-row table's FK column under Jaccard).
- `MIN_UNIQUE = 1` — lowered from 5 after the matricule=1243
  case showed that single-value joins are real (a user-filtered
  view of one customer's rows joining to the customer table).

### `group_by::aggregate` — Polars lazy reduce

```rust
pub fn aggregate(df: DataFrame, spec: &GroupSpec) -> Result<DataFrame> {
    let by: Vec<Expr> = spec.by.iter().map(|c| col(c)).collect();
    let aggs: Vec<Expr> = spec.aggs.iter().map(|a| {
        let base = col(&a.column);
        let expr = match a.agg.as_str() {
            "sum"   => base.sum(),
            "mean"  => base.mean(),
            "min"   => base.min(),
            "max"   => base.max(),
            "count" => base.count(),
            "first" => base.first(),
            "last"  => base.last(),
            other   => return Err(DataError::InvalidSpec(format!(
                "unsupported agg: {other}"))),
        };
        Ok(a.alias.as_ref().map(|s| expr.clone().alias(s)).unwrap_or(expr))
    }).collect::<Result<_>>()?;
    df.lazy().groupby(by).agg(aggs).collect().map_err(DataError::from)
}
```

- **No materialization until `.collect()`** — Polars optimizes the
  full pipeline before executing.
- **Per-agg memory** is O(group_count × agg_count). For typical
  reports (< 1000 groups), this is trivial; for a high-cardinality
  groupby (per-row group), we're computing one row per input row
  — still tractable but the result frame matches the input
  height.

### `stats::cleanness_pct` — the scoring formula

```rust
pub fn cleanness_pct(df: &DataFrame, columns_meta: &[ColumnMeta]) -> f32 {
    let mut score: f32 = 0.0;
    let mut weight: f32 = 0.0;
    for meta in columns_meta {
        let col_weight = 1.0;
        weight += col_weight;
        // Null penalty
        score += (1.0 - meta.null_pct) * 0.5 * col_weight;
        // Dtype match penalty: storage vs semantic mismatch docks proportionally
        if meta.dtype != meta.semantic_dtype {
            let cast_success_rate = try_cast_count(&df[&meta.name], &meta.semantic_dtype) as f32
                                    / df.height() as f32;
            score += cast_success_rate * 0.5 * col_weight;
        } else {
            score += 0.5 * col_weight;
        }
    }
    if weight == 0.0 { return 100.0; }
    (score / weight) * 100.0
}
```

- **50/50 split** between null-completeness and dtype-coherence.
  Reflects the intuition that a 95%-non-null column with
  parsing failures isn't "clean" — both axes matter.
- **`try_cast_count`** walks the column, tries the semantic dtype
  cast per cell, counts successes. O(n) per dirty column; the
  hot path only fires for columns where dtype ≠ semantic_dtype
  (which is the minority on most files).
- **Per-column weight is 1.0 today** — flat average. A future
  optimization: weight by data-volume (heavier columns count
  more) or by user-edited columns (recent steps count more).
  Both require an explicit signal we don't track yet.

### `clean::auto_clean` — the three-step transform

```rust
pub fn auto_clean(df: &DataFrame) -> Result<(DataFrame, CleanSummary)> {
    let mut summary = CleanSummary::default();
    // 1+2: per string column, trim + blank junk.
    let mut columns: Vec<Series> = Vec::with_capacity(df.width());
    for series in df.get_columns() {
        if series.dtype() != &DataType::String {
            columns.push(series.clone()); continue;
        }
        let chunked = series.str()?;
        let cleaned: Vec<Option<&str>> = chunked.into_iter()
            .map(|cell| cell.and_then(|raw| {
                let trimmed = raw.trim();
                if trimmed.len() != raw.len() { summary.cells_trimmed += 1; }
                if is_junk(trimmed) { summary.junk_blanked += 1; None }
                else                { Some(trimmed) }
            })).collect();
        columns.push(Series::new(series.name().clone(), cleaned));
    }
    let trimmed = DataFrame::new(columns)?;
    // 3: drop fully-identical duplicate rows.
    let before = trimmed.height();
    #[cfg(not(target_arch = "wasm32"))]
    let deduped = trimmed.unique_stable(None, UniqueKeepStrategy::First, None)?;
    #[cfg(target_arch = "wasm32")]
    let deduped = drop_dupe_rows_serial(trimmed)?;
    summary.duplicate_rows_dropped = before - deduped.height();
    Ok((deduped, summary))
}
```

**The junk-sentinel set** lives in `clean::SENTINELS` —
case-insensitive match after trim. Today's set: `""`, `"NA"`,
`"N/A"`, `"na"`, `"n/a"`, `"null"`, `"NULL"`, `"None"`, `"none"`,
`"-"`, `"—"`, `"#N/A"`, `"#NA"`, `"#NULL!"`, `"?"`. Globally
promoted entries (`learned_sentinels` shared via the
`sentinel_submissions` table) merge here at hydrate time — see
[prefs §learned-sentinels](prefs.md).

**Wasm dedup branch** — `unique_stable` goes through rayon's
POOL on Polars 0.43, which traps on `wasm32-unknown-unknown`. The
serial replacement walks the rows with a
`HashSet<Vec<String>>` of `{:?}`-formatted cell signatures and
rebuilds each Series per its concrete dtype. Slower than the par
version on big frames (O(n) signature compute + O(n) typed
rebuild) but linear in row count and trivially correct. See
[wasm-engine §rayon-trap](wasm-engine.md#the-rayon-trap--serial-dedup).

### `export` — direct-to-disk streaming

```rust
pub fn write_csv_to_disk(df: &mut DataFrame, path: &Path) -> Result<()> {
    let file = std::fs::File::create(path)?;
    CsvWriter::new(file)
        .include_header(true)
        .with_separator(b',')
        .finish(df)?;
    Ok(())
}
```

**Why no `Vec<u8>` intermediate**: OOM during a 400k×400k join
(per the [joins](../../features/joins.md) doc — same issue, same
fix). `CsvWriter::new(file)` writes directly to the file
descriptor; Polars manages a small write buffer internally
(~64KB).

XLSX export uses `rust_xlsxwriter::Workbook::new()` which IS
in-memory (no streaming API today). For exports larger than a few
hundred MB, the path forks: CSV streams, XLSX fails with
`DataError::Export("file too large for in-memory xlsx")`. Future
work: stream-XLSX via the `xlsxwriter` C library or
`umya-spreadsheet`'s streaming API.

### `render` — server-only, hard-gated

```rust
#[cfg(not(target_arch = "wasm32"))]
pub mod render;
```

The module body uses `pulldown-cmark` + `syntect` + `gray_matter`
+ `maud`. `syntect → onig_sys` needs `clang` to build a C regex
engine and pulls `crossterm` — both kill wasm32 builds. The cfg
gate at the `pub mod` site is the load-bearing line; the
Cargo.toml mirrors it in
`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`.

Don't import anything from `render` into another `data` module
that DOES compile to wasm — that re-exports the gate violation.
The compiler will catch it but the failure message ("crossterm
unresolved at `data::wasm::…`") is hard to track to the real
cause.

## Optimization map — where the cost lives

Rough budget per typical 178-row CSV (the fleury sample
exercises this):

| Phase | Cost | Optimization horizon |
|---|---|---|
| Encoding detect | <1 ms | n/a — chardetng is the speed-of-light here |
| CSV parse | ~5 ms | n/a at this size; bigger files benefit from `LazyFrame` |
| dtype::summarize (per column) | ~0.2 ms × n_cols | acceptable; sampling cap (100) is the lever |
| clean::auto_clean | ~2 ms | dedup is the dominant cost on bigger frames — server `unique_stable` already par |
| Step replay (cache miss) | O(n_steps × frame ops) | snapshot point at ordinal N if step counts climb past ~50 |
| Page query (filter + sort + paginate) | ~1 ms | LazyFrame already; `slice(offset, limit)` is the final op |

For a 100k-row CSV the same pipeline runs in ~50ms wall-clock end
to end on the dev machine. The bottleneck would tip to
`unique_stable` (full-frame hash) on the dedup step — par_iter
helps but a snapshot point would help more.

For 5M rows, the bottleneck is the file_size_bytes → parse memory
ratio — Polars 0.43 loads the whole CSV; switching to
`scan_csv()` (truly lazy) would let the row-count exceed
available RAM at the cost of more disk IO. Phase-C-territory per
the WASM roadmap, but the lever applies to the server too.

