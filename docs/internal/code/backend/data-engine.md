# Data engine — the Rust `data` crate

`backend/crates/data` is **pure compute over Polars** dataframes. One engine, two
surfaces: this exact crate is linked natively by the `api` crate AND compiled to
`wasm32` and run in the browser. Zero io / http / threads / time **by law** —
`tools/purity-check.sh` gates every commit on a `wasm32 cargo check`, so the
purity is enforced, not just intended. That purity is the whole point: it is what
lets a page, a filtered window, a score, or a SQL result computed **in the
browser** be byte-identical to the server's for the same bytes — and the rows
never leave the device.

The contract both surfaces speak is the **page shape** `{ columns, rows, total }`
(`rows` = arrays of stringified cells aligned to `columns`), emitted identically
by `data::view::page` on the server and by the wasm `Workbook` in the browser.

This doc covers the four engine surfaces:
1. [Cleaning steps](#cleaning-steps--datastepsapply-dispatch) — `steps::apply`
2. [Group-by / reports](#group-by--reports--datagroup_byexecutedf-reportspec) — `group_by::execute`
3. [Filters](#filters--the-canonical-filternode) — the canonical `FilterNode`
4. [wasm](#wasm--datawasm-the-resident-client-engine) — `data::wasm` resident `Workbook`

---

## Cleaning steps — `data::steps::apply` dispatch

A step is `shared::Step` = `{ kind: String, params: Value }`. `kind` is **free-form
text** — the single switch from an open string → a Polars op lives in
`steps::apply`, so **a new op ships with zero DB/DTO/route changes**; unknown
kinds fall through to a clean `DataError::InvalidSpec`. This is the day-one
disposability bet: a clean operation is one `match` arm, deletable at near-zero
cost.

```rust
pub fn apply(df: DataFrame, kind: &str, params: &serde_json::Value) -> Result<DataFrame>
```

`replay(base, &[Step])` threads the steps in order over the immutable base CSV —
the api crate's hydrate path reconstructs the current view this way
(non-destructive editing; undo = flip a step's `applied` flag, then re-replay).

### Every supported `kind`

| kind | module | params (key fields) |
|---|---|---|
| `drop_columns` | `columns` | `{ cols:[string] }` |
| `filter_columns` | `columns` | `{ cols:[string] }` (names to KEEP, in order) |
| `rename_column` | `columns` | `{ from, to }` |
| `snake_case_columns` | `columns` | `{}` |
| `replace_in_names` | `columns` | `{ find, replace? }` |
| `drop_rows` | `rows` | `{ indices:[int] }` — **position-based** |
| `filter_rows` | `rows` | `{ combinator?:"and"\|"or", predicates:[{column, op, value?, case_sensitive?}] }` (lifted into one `FilterNode`; `case_sensitive` defaults **true** for persisted steps) |
| `drop_nulls` | `rows` | `{ cols?:[string] }` (empty = all columns) |
| `set_cell` | `cells` | `{ row:int, column, value? }` (null/blank → NULL) — **position-based** |
| `fill_nulls` | `cells` | `{ strategy?:"fixed"\|"zero"\|"forward", column?, value? }` |
| `cast` | `cells` | `{ column, dtype:"int"\|"float"\|"str"\|"bool"\|"date"\|"datetime"\|"time" }` — locale-aware FR number/bool coercion **only when the source column is `String`** |
| `change_case` | `cells` | `{ mode:"lower"\|"upper" }` (string columns only) |
| `replace_text` | `cells` | `{ column, find, replace?, is_regex?:bool }` |
| `fix_invalid` | `cells` | `{ sentinels:[…], columns?:[…], replacement? }` (legacy `{column, sentinel}` shape still replays; null replacement → NULL) |
| `unwrap_csv` | `structure` | `{}` — **single-column frames only** (errors otherwise); per-row delimiter + quote sniff |
| `join_columns` | `structure` | `{ col1, col2, sep?=" ", new_name? }` — exactly 2 columns |
| `split_column` | `structure` | `{ column, sep?=",", keep_original?=false }` — caps at **MAX_PARTS = 10** new columns |
| `format_dates` | `structure` | `{ column, fmt?="%Y-%m-%d" (must contain a `%` specifier), on_incomplete?="null"\|"drop"\|"keep" }` |
| `original` | (dispatch) | `{}` — genesis marker, **identity** (transforms nothing) |

The dispatch routes to four submodules — `columns`, `rows`, `cells`, `structure`
— plus one crate-visible `util` module. `util` exposes the **one** filter-predicate
compiler (`build_filter_predicate`), reused by `crate::filter` (see below), which
is why it is `pub(crate)` rather than private to `steps`; everything else in it
stays `pub(super)`-gated.

### Two gotchas worth pinning

- **`unwrap_csv` / `join_columns` / `split_column` / `format_dates` are fully
  implemented** (`steps::structure`, each a real Polars impl with a passing test).
  A stale comment in `steps/mod.rs` still calls them "deferred" — **ignore it**;
  the dispatch routes to working impls.
- **`set_cell` and `drop_rows` are position-based** (`row` / `indices` are frame
  positions, not key lookups). That is exactly why the Data Cleaner gates
  edit/delete under a filter — see `data-cleaner.md`. The genesis `original` marker
  carries the baseline cleanness on its ordinal-0 step record but transforms
  nothing, so replaying it is the identity (the base CSV already IS that state).

---

## Group-by / reports — `data::group_by::execute(df, &ReportSpec)`

```rust
pub fn execute(df: &DataFrame, spec: &ReportSpec) -> Result<DataFrame>
```

`ReportSpec` (`shared/src/report.rs`, **all `#[serde(default)]`** so a bare `{}` is
a valid spec):

- `group_by:[string]` (row groups) + `group_by_cols:[string]` (column/pivot
  groups) — the pivot matrix is a frontend concern; from Polars' view both are
  **combined into one `group_by`** over both dimensions.
- `aggregations:[{ col, fn: AggFn, alias? }]` — `col:"*"` is the **count-of-rows
  shortcut** (compiles to `lit(1i64).count()`, so it works regardless of column
  existence).
- `filter?` — a `FilterNode` JSON value used as a **pre-filter**; the same tree the
  cleaner uses, deserialized and compiled to one Polars `Expr` right here
  (null / empty-AND-group leaves the frame untouched).
- `sort:[{col, dir:"asc"|"desc"}]`, `top_n?:{n, order_by, direction?, partition_by?}`,
  `windows:[WindowSpec]`, `charts:[ChartSpec]`.
- display flags: `show_details` / `show_subtotals` (default true), `show_total`
  (default false).

### The pipeline order (what `execute` does, in order)

1. **Pre-filter** — deserialize `spec.filter` → canonical `FilterNode` → one Polars
   predicate, applied lazily. Empty / null = no constraint.
2. **Combine group keys** — `group_by ++ group_by_cols` into one key list.
3. **Aggregations** — if grouping was requested but no aggs were given, an implicit
   row-`count` is added so the result is never empty.
4. **Group-by** — with group columns, `group_by(...).agg(...)`; with **no** group
   columns, `select(aggs)` for a single summary row (and with no aggs either,
   return a single `{rows}` summary cell = `df.height()`).
5. **Collect, then sort eagerly** — `collect()`, then `DataFrame::sort` (NOT lazy
   `sort_by_exprs` chained off `group_by().agg()` — that has been observed to
   *silently drop* in some Polars builds). The sort only fires when the **user**
   asked (`spec.sort` non-empty); auto-tie-breakers append remaining group-by
   columns ascending so subtotals stay hierarchically grouped, but they never
   reorder against the natural Polars output on their own.
   - **Windows** (step 5b) run *before* sort/top-N so users can sort by or top-N
     filter on a window-derived column.
6. **Top-N** (post-aggregation) — sort + `head(n)` globally, or
   `group_by_stable(partition).head(n)` per partition. Applied last so the user
   sort above is preserved.

### `AggFn` (snake_case)

`count`, `count_distinct`, `sum`, `mean`, `min`, `max`, `first`, `last`,
`median`, `q1`, `q3`. (`report-spec.js` exposes the first eight.) Each maps to a
Polars `Expr` (`q1`/`q3` → `quantile(0.25 / 0.75, Linear)`); the default alias is
`count`/`distinct`/`sum`/… for `col:"*"`, else `{col}_{fn}`.

**Behavior summary:** no group + no agg → single `{rows}` summary; group + no agg
→ implicit `count`; no group + agg → single summary row.

### `WindowSpec.fn`

- **Aggregate windows** — `sum | mean | count | min | max`, with optional
  `as_percent` (computes `x / window * 100`, with an explicit `Float64` cast so
  integer division doesn't silently produce zeros). `partition_by` empty = a
  whole-frame window.
- **Value windows** — `lag | lead | first_value | last_value`, which **require an
  `order_by`** (the frame is sorted by it once before the expression is computed,
  so "previous" / "first" are deterministic). `lag`/`lead` use `offset` (min 1).

---

## Filters — the canonical `FilterNode`

`shared/src/filter.rs` is **THE one filter shape** in RedPash (day-one decision
#4). There is exactly one, consumed by every row-reducing path: server-side
paging, the `filter_rows` cleaning step, `group_by` pre-filters, and the wasm
`Workbook`. The predecessor carried a flat `Vec` spec **and** a tree spec — that
split was the only reason filter/search couldn't run client-side. **Never
introduce a second shape; extend this one.**

`#[serde(tag="node", rename_all="snake_case")]`:

- `{ "node":"group", "op":"and"|"or", "children":[FilterNode] }` — **empty children
  = match-all** (`FilterNode::all()`).
- `{ "node":"pred", "col", "op":PredOp, "value"?, "case_sensitive"? }` — leaf; wire
  default `case_sensitive: false` (query-time UX mirrors global search; persisted
  cleaning steps set it `true` explicitly). `value` is absent for `is_null` /
  `not_null`.

`PredOp` (snake_case): `eq`, `neq`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `gt`, `gte`, `lt`, `lte`, `between` (`value:[low,high]`), `in`
(`value:[…]`), `is_null`, `not_null`.

### `data::filter::apply_filter(&df, &FilterNode)`

```rust
pub fn apply_filter(df: &DataFrame, f: &FilterNode) -> Result<DataFrame>
```

- **Recursive** over nested groups — so DC3c's nested AND/OR is a *frontend-only*
  change; the engine already compiles arbitrary depth.
- **Match-all fast path**: an empty group returns the frame unchanged — no lazy
  roundtrip, no collect — so paging an unfiltered file is identical to a bare GET
  page. An empty child contributes `None` to its parent's and/or fold (it bubbles
  up rather than forcing a `lit(true)`/`lit(false)`), so an empty nested group
  never poisons its parent.
- The whole tree compiles to **one** `Expr` and collects **once** at the top
  (`df.lazy().filter(expr).collect()`).
- **One compiler, not two**: every leaf goes through
  `steps::util::build_filter_predicate` — the same op→`Expr` match the persisted
  `filter_rows` step uses. The `PredOp` enum and the persisted `op` strings are two
  views of the same vocabulary, pinned by `pred_op_str` / `pred_op_from_str` in
  `filter.rs` (one source of truth for the string↔enum mapping). Numeric ops cast
  the *value* → f64 (Polars widens the column side); string ops cast the *column* →
  `String` (guards against drift to Categorical / Utf8View).

### Search composes to the same shape

`data::search` is **not** a second filter engine. The toolbar's free-text box ("any
column contains *text*") compiles to an **OR of `contains` predicates** across every
column (case-insensitive), i.e. a `FilterNode` that rides `apply_filter`.
`search::effective_filter(df, filter?, search?)` AND-combines the structured panel
filter with the search into one tree (dropping any match-all side; returning `None`
when both are match-all so the caller skips the roundtrip). This is the one place
the two row-reducers combine — identical on the server and in the browser.

---

## wasm — `data::wasm` (the resident client engine)

`backend/crates/data/src/wasm.rs` is the **wasm-bindgen boundary**: thin
JSON-string-in / JSON-string-out wrappers over the **same** engine functions the
server calls. No Polars types and no per-DTO glue cross the boundary — the
marshaling layer is all there is, which keeps the size measurement honest (the
wasm binary's *content* == the server engine's content). The whole module is
`#![cfg(target_arch = "wasm32")]`; `start()` (`#[wasm_bindgen(start)]`) installs
the panic hook so a Rust panic surfaces in the browser console with file + line +
payload.

> **The JS method surface is GENERATED from these `#[wasm_bindgen]` exports** (via
> wasm-bindgen's output), never a hand-maintained array. The predecessor's
> 13-exports-vs-6-wired drift is **designed out** — if a method is exported here,
> it is callable from JS, full stop. **This table must list every export.**

### Top-level function

| Export | Signature | Returns |
|---|---|---|
| `parse_score` | `(bytes: &[u8], tld: Option<String>)` | JSON `{rows, cols, score, report{…}, columns, sentinels, encoding, rescue}` |

`parse_score` runs the **same** upload front door as the server (`parse::from_csv_bytes`
→ `dtype::summarize` → `stats::cleanness_report`), then augments the shared score
payload with the parse-time `encoding` + `rescue` diagnostics only the front door
knows. `tld` is the locale hint (e.g. `"fr"`) for the locale-aware decode.

### `Workbook` — a parsed CSV held resident in browser memory

The instance methods are the **snake_case-free** names below (wasm-bindgen would
otherwise camelCase them; `js_name = from_csv` pins the constructor's name).

| Method | Signature | Returns |
|---|---|---|
| `from_csv` | `(bytes: &[u8], tld: Option<String>)` — **constructor** | `Workbook` |
| `page` | `(offset: usize, limit: usize)` | JSON `{columns, rows, total}` — `total` = FULL row count |
| `filter_page` | `(filter_json: &str, offset: usize, limit: usize)` | `{columns, rows, total}` — `total` = FILTERED height |
| `view` | `(query_json: Option<String>, offset: usize, limit: usize)` | `{columns, rows, total}` — `total` = post-(filter+search) height |
| `score` | `()` | `{rows, cols, score, report{…}, columns, sentinels}` (the `parse_score` payload minus the parse-time encoding/rescue diag) |
| `sql` | `(query: &str)` | **first 500 rows** of the result `{columns, rows, total}` (the result *set* must be ≤ `ROW_CAP`) |
| `rows` | `()` | `usize` — resident frame height |
| `cols` | `()` | `usize` — resident frame width |

Each method reuses the exact server-side function, so its output is byte-identical
to the server's for the same bytes:

- **`from_csv`** — parses raw CSV bytes into the resident frame via the same front
  door as `parse_score` (`parse::from_csv_bytes`: decode + sniff + read).
- **`page`** — a `[offset, offset+limit)` window via `view::page`. `total` is the
  full frame height.
- **`filter_page`** — deserializes a `FilterNode` (the canonical wire tree;
  `{node:"group"|"pred", …}`, empty group = match-all), applies
  `filter::apply_filter`, then windows the result. `total` is the **filtered**
  height, so the client shows "N of M-filtered". The whole tree compiles to one
  `Expr` and collects once — the lazy-collect-in-a-single-thread path the smoke
  test exercises to catch fork panics.
- **`view`** — *the composable window.* `query_json` is the canonical `QuerySpec`
  `{ filter?, search?, sort? }` (`null` / `{}` = the whole frame; `sort` is a `Vec<SortKey>`,
  `SortKey = { col, descending: bool }` — distinct from the report engine's `SortSpec
  {col, dir}` above); pagination is the
  `offset`/`limit` args. It applies **(filter AND search) → sort → page** — the
  **same order and same shape** the server's POST `/page` runs (the (filter+search)
  predicate via `search::effective_filter` + `filter::apply_filter`; the sort via
  `sort::apply_sort`, both skipped when empty). One method serves the whole
  à-la-carte family (bare, searched, filtered, sorted, or any combination). `total`
  is the post-(filter+search) height — **sort never changes it**.
- **`score`** — the cleanness report over the resident frame; the same score payload
  `parse_score` returns, minus the parse-time encoding/rescue diag.
- **`sql`** — runs a **read-only** SQL query against the resident frame exposed as
  table `t`, via the **same** engine + read-only guard the server `/sql` runs
  (`crate::sql::run_sql`). Returns the **first 500 rows** of the result; the result
  *set* must be ≤ `ROW_CAP` (`run_sql` rejects larger — add a `LIMIT` to narrow). Multi-file joins (extra named
  tables) stay on the server.
- **`rows` / `cols`** — resident frame height / width.

> **Drift note (read this).** An earlier draft of the frontend-facing table listed
> only `from_csv` / `page` / `filter_page` / `score` / `rows` / `cols` and **omitted
> `view` and `sql`**. Both are first-class `#[wasm_bindgen]` exports on `Workbook`:
> `view` is the composable QuerySpec window (filter + search → sort → page) and
> `sql` is the read-only SQL console over the resident frame. Because the JS surface
> is *generated* from the exports, the table here is the same eight names JS sees —
> there is no "wired vs exported" gap to track.

---

## DC3 needs NO new backend

DC3 ships entirely on the surface above — no new routes, no new wasm wrappers:

- **Reports** → `POST /api/group/preview` with a `ReportSpec`.
- **Every clean op** → `POST /api/files/:rid/steps` with `{kind, params}` — `kind`
  is free-form text, so a new op needs no DB/DTO/route change; it routes through the
  existing `steps::apply` dispatch.
- **Nested AND/OR filters** → the recursive `FilterNode`, consumed identically by
  `/files/:rid/page`, the `filter_rows` step, `group/preview`'s pre-filter, and wasm
  `filter_page` / `view` — so DC3c's nesting is a frontend-only change.
