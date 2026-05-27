---
title: Step engine
section: Internal
order: 27
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Step engine

A **step** is one cleaning operation applied to one file —
`{ kind, params }` persisted as a `project_steps` row. The engine
replays every applied step in `ordinal` order against the parsed
base frame on every read; the cached result is the DataFrame the
redtable + every other consumer sees.

This is the layer that makes cleaning **non-destructive** — the
original bytes on disk never change. Every transform is a step;
undo flips the row, doesn't rewind it.

Source of truth: `backend/crates/data/src/steps/mod.rs` (the dispatch
match arm; per-family bodies live in `steps/{rows,columns,cells,structure,util}.rs`)
+ `backend/crates/api/src/routes/files/mod.rs` (the apply / undo /
redo endpoints) + `routes/files/state_ops.rs` (the cleaner cursor
ops) + `routes/files/output.rs` (snapshot).

## Model

`project_steps` schema:

```
redpash_id       text   PK         — STP_…
file_redpash_id  text   FK→project_files ON DELETE CASCADE
ordinal          int               — position in the file's step history (1-based)
kind             text              — see catalog below
params           jsonb  default '{}'  — op-specific arguments
applied          bool   default true  — flips false on undo; true on redo
created_at       timestamptz
```

Index: `(file_redpash_id, ordinal)`. Trigger: `project_steps_bump_file`
(`AFTER INSERT/UPDATE/DELETE FOR EACH ROW`) calls
`bump_file_mtime_from_step()` so the parent file's `updated_at`
tracks the step history.

See [monitoring-schemas](../specs/monitoring-schemas.md) §5 for the
full per-table reference.

## The 17 step kinds

The dispatch lives in `data::steps::apply(df, kind, params)`. One
match arm per kind; the arm reads `params` per its expected shape
and returns the transformed DataFrame.

| Kind | Behavior | `params` shape |
|---|---|---|
| `drop_columns` | Remove columns by name | `{ columns: ["a","b"] }` |
| `filter_columns` | Keep only listed columns (the inverse) | `{ keep: [...] }` |
| `drop_rows` | Remove rows by absolute frame index | `{ indices: [0,2,5] }` |
| `filter_rows` | Apply a row predicate (multi-clause AND/OR over [filter-dto](../specs/filter-dto.md)) | `{ combinator: "and"\|"or", predicates: [{column, op, value?, case_sensitive?}, …] }` |
| `unwrap_csv` | Re-parse a single-column wrapped CSV (peels outer quotes, sniffs inner delim per row) | (no params) |
| `drop_nulls` | Drop rows with null in named columns | `{ columns: ["x"] }` |
| `set_cell` | Edit one cell — used by the redtable's contenteditable | `{ row: 7, column: "name", value: "Alice" }` |
| `fill_nulls` | Fill nulls with a value or `forward` | `{ columns: [...], strategy: "value"\|"forward", value? }` |
| `cast` | Change a column's storage dtype | `{ column: "x", to: "int"\|"float"\|"date"\|"bool"\|"string" }` |
| `rename_column` | Rename one column | `{ from: "old", to: "new" }` |
| `snake_case_columns` | snake_case every column header (idempotent) | (no params) |
| `replace_in_names` | Find/replace in column names | `{ find: "...", replace: "..." }` |
| `change_case` | lower/upper-case the values of a string column | `{ column: "x", case: "lower"\|"upper" }` |
| `replace_text` | Find/replace in a column's values | `{ column: "x", find: "...", replace: "..." }` |
| `fix_invalid` | Coerce parse-failing cells to NULL on a typed cast | `{ column: "x", as: "int"\|"float"\|"date" }` |
| `join_columns` | Concatenate columns into a new one | `{ from: ["a","b"], sep: " ", to: "full_name" }` |
| `split_column` | Split one column into many on a separator | `{ column: "x", sep: ",", to: ["a","b"] }` |

`filter_rows`'s predicate op set is the canonical 17-variant
`FilterOp` — see [filter-dto](../specs/filter-dto.md).

## Apply / replay lifecycle

The DataFrame the user sees is **not stored** — it's computed on
demand from `(base bytes) + (every applied step in order)`. The
flow:

1. **First read of a file after server boot / cache miss:**
   - Hydrator (`routes::files::hydrate`) loads bytes from
     `REDPASH_DATA_DIR/files/<rid>.bin`.
   - `data::parse::*` produces the base DataFrame.
   - `data::steps::replay(base, steps)` iterates the applied steps
     by ordinal, calling `apply(df, kind, params)` for each.
   - Result is cached on `AppState.files` (a `DashMap<rid, Arc<DataFrame>>`).
2. **Subsequent reads** hit the cache directly.
3. **Mutating endpoint** (apply / undo / redo / encoding change /
   ANY change that affects the frame): the hydrator invalidates
   the cache entry; the next read re-replays from the base.

Cache invalidation is the load-bearing detail — every endpoint
that mutates state on the file path **must** invalidate the cache
key for that RID. See `routes::files::invalidate_cache(rid)`.

See [flows/step-apply-and-replay](../flows/step-apply-and-replay.md)
for the full waterfall with timing notes.

## Apply — `POST /api/files/:rid/steps`

Body: `shared::step::StepRequest { kind, params }`.

Lifecycle inside the handler:

1. **Resolve user + check ownership** — `resolve_user_rid` +
   `ensure_owner` per the [api-routes](api-routes.md) pattern.
2. **Hydrate the file** — replay the existing steps if not cached.
3. **Pre-flight**: call `steps::apply(df.clone(), kind, &params)`
   *before* persisting. If it errors, return 400 with
   `kind="invalid_spec"` (or whatever the engine returned); never
   persist a step that we know will fail to replay.
4. **Persist** — `INSERT INTO project_steps (file_redpash_id,
   ordinal, kind, params, applied=true)` with `ordinal = MAX+1`.
5. **Invalidate cache** for this file RID.
6. Return the updated `ProjectStep` row.

The pre-flight makes the engine **safe-by-default for redo**: any
step that's ever been persisted is one we already executed
successfully against the file's then-current frame. Re-applying
on every replay isn't a gamble.

## Undo / redo

Both flip the `applied` boolean — no row deletion. The "step
history" the user sees on the file is the full chronological
record; undo just chooses which prefix is currently materialized.

`POST /api/files/:rid/undo`:

1. Find the topmost `applied=true` step (max ordinal where applied).
2. UPDATE that row to `applied=false`.
3. Invalidate the cache.
4. Return the new top-of-stack.

`POST /api/files/:rid/redo`:

1. Find the bottommost `applied=false` step that's above any
   currently-applied step (the next-to-apply).
2. UPDATE to `applied=true`.
3. Invalidate the cache.
4. Return the newly-applied step.

`replay()` walks `applied=true` rows in ordinal order — it never
sees an `applied=false` row, so an undone step is silently absent
from the materialized frame.

**Branching after an undo.** Today: applying a new step after an
undo *does not* discard the previously-undone tail; the new step
gets the next ordinal, and the undone tail can still be redone. UI
needs to either bury the tail or warn that redoing it will re-
apply on top of the new history. Tracked as known UX debt.

## Snapshots — `POST /api/files/:rid/snapshot`

A snapshot materializes the *currently-replayed* DataFrame as a new
file row (`project_files`) with its own `redpash_id` and a fresh
bytes blob. The original file + its step history are untouched;
the snapshot starts with zero steps.

Use case: "I want to fork this cleaning state and try a different
direction without losing where I am." The snapshot is a real file
and gets its own URL.

## Adding a new step kind

1. **Pick the params shape.** Stick to `serde_json::Value` in the
   table; document the expected shape in the dispatch arm's comment.
   Validate shape inside the arm — return
   `DataError::InvalidSpec(...)` with a human message for any
   missing / wrong-typed param.
2. **Add the match arm in `data::steps::apply`.** Keep it pure:
   take the DataFrame, return a new DataFrame, no IO.
3. **Wire it into the UI.** The 12 cleaning-tool buttons in the
   workspace come from `frontend/scripts/tools.js` (the
   `defineTool` factory). Adding a new button there + a new server
   step is the user-facing path. For internal-only steps (used by
   other steps), skip the UI.
4. **No DB migration needed** — `project_steps.kind` is `text`,
   no CHECK. The engine validates by recognising the kind string;
   unknown kinds return `InvalidSpec("unknown step: <kind>")`.
5. **Test:** add a unit test in `steps.rs` under `#[cfg(test)] mod
   tests` — build a small DF via `df![…]`, call `apply`, assert
   the shape.
6. **Update [monitoring-schemas](../specs/monitoring-schemas.md) §5's
   kinds table** so the canonical catalog stays current — per
   [keep-comments-truthful](../processes/docs-lane-ownership.md).

## Cross-cuts

- **Idempotence not guaranteed.** Most steps are idempotent
  (`snake_case_columns` twice == once), but `set_cell` /
  `drop_rows` change history each time. The engine doesn't dedupe;
  applying the same step twice persists two rows.
- **Order matters.** `cast` on a column that a later
  `replace_text` step expects as String will replay-fail. The
  engine doesn't reorder. UI considerations belong in the workspace.
- **No cross-file steps.** Every step operates on one file's
  DataFrame. Joins are a separate flow that creates a *new file*
  (a result), they're not a step on either input.
- **Step engine on wasm.** `data::steps::apply` compiles for
  wasm32. The Phase B `step_preview(rows_json, kind, params_json)`
  wasm wrapper exposes the full 17-kind palette to the browser —
  see [wasm-engine](wasm-engine.md).

## Rust internals — algorithm + tuning per step kind

Each step's implementation in `data::steps::apply`, the params
it expects, the Polars primitives it uses, and the
optimization-relevant decisions.

### Dispatch shape

```rust
pub fn apply(df: DataFrame, kind: &str, params: &serde_json::Value)
    -> Result<DataFrame>
{
    match kind {
        "drop_columns"    => { /* ... */ }
        "filter_columns"  => { /* ... */ }
        "drop_rows"       => { /* ... */ }
        "filter_rows"     => { /* ... */ }
        "unwrap_csv"      => { /* ... */ }
        "drop_nulls"      => { /* ... */ }
        "set_cell"        => { /* ... */ }
        "fill_nulls"      => { /* ... */ }
        "cast"            => { /* ... */ }
        "rename_column"   => { /* ... */ }
        "snake_case_columns" => { /* ... */ }
        "replace_in_names" => { /* ... */ }
        "change_case"     => { /* ... */ }
        "replace_text"    => { /* ... */ }
        "fix_invalid"     => { /* ... */ }
        "join_columns"    => { /* ... */ }
        "split_column"    => { /* ... */ }
        other => Err(DataError::InvalidSpec(
            format!("unknown step: {other}"))),
    }
}
```

One match arm per kind; the arm reads `params` per its expected
shape and returns the new DataFrame. The dispatch is exhaustive
by design — adding a kind without an arm gets the catch-all
error.

### Column-shape ops — `drop_columns` / `filter_columns` / `rename_column`

```rust
// drop_columns
let cols = params["columns"].as_array()?;
let drop: Vec<&str> = cols.iter().filter_map(|v| v.as_str()).collect();
df.drop_many(&drop)
```

**Allocation**: zero — `drop_many` returns a new `DataFrame`
that aliases the kept columns. The dropped columns' Series are
dropped only if no other reference exists.

`filter_columns` is the inverse via `df.select(keep)`. Same
zero-copy property.

`rename_column`: `df.rename(from, to)?` — in-place mutation;
returns a `&mut DataFrame`. Constant-time.

### `drop_rows` — index-based row removal

```rust
let indices: Vec<u32> = params["indices"].as_array()?
    .iter().filter_map(|v| v.as_u64()).map(|n| n as u32).collect();
let mask: BooleanChunked = (0..df.height() as u32).map(|i| !indices.contains(&i)).collect();
df.filter(&mask)
```

**Performance**: `contains` on `Vec<u32>` is O(n) per check, so
the mask build is O(rows × indices). For typical user actions
(deleting a handful of rows) this is negligible; if a "select all
nulls in column X → drop" tool ever pushes thousands of indices,
swap to `HashSet<u32>` for O(1) per check.

### `filter_rows` — multi-predicate filter

Uses [filter-dto](../specs/filter-dto.md). Builds one
`polars::Expr` per predicate via `build_filter_predicate`, reduces
with `.and()` / `.or()` per the `combinator`, applies through
`df.lazy().filter(expr).collect()`.

**Lazy is the win** — Polars optimizes the predicate AST
(constant folding, expression pushdown) before materialization.
Multi-clause filters are no more expensive than single-clause as
long as you pass them in one `.filter()` call.

**`case_sensitive` default is `true`** on this path (the
persisted-step engine). Calling `setPref`-style insensitive
matches require explicit `case_sensitive: false` in params.
Different from `parse::filter_expr`'s default — deliberate
asymmetry documented in [filter-dto §case_sensitive defaults](../specs/filter-dto.md#case_sensitive-defaults--deliberate-asymmetry).

### `unwrap_csv` — wrapped-CSV rescue

Refuses to operate on a DF with `width != 1` (defense against
re-running after a prior unwrap). For each row:

1. `defensive_unquote(value)` — peel outer `"..."` if balanced,
   replace `""` with `"`.
2. `sniff_delim(record)` — most-frequent of `,;|\t` in *this row*
   (per-row, not file-wide, because wild wrapped CSVs are
   inconsistent).
3. Build a canonical `,`-delimited CSV from all unwrapped rows.
4. Feed back through `data::parse::csv_bytes_to_df(canonical)` for
   typed re-parse.

See [data-engine §parse — unwrap_csv_string](data-engine.md#parse--csvxlsxjson--dataframe)
for the algorithm in full. Cost: O(n × col_count) two-pass; only
fires on user demand for the file shape that needs it.

### `drop_nulls` — strict per-column null drop

```rust
df.drop_nulls(Some(&params["columns"].as_array()?))
```

Polars' built-in: drops a row if any named column is null.
Stable; preserves row order in the survivors. O(n × col_count_in_list).

### `set_cell` — surgical edit

```rust
let row: usize = params["row"].as_u64()? as usize;
let col_name: &str = params["column"].as_str()?;
let value = params["value"].clone();
let col = df.column(col_name)?.clone();
let mut builder = AnyValueBuilder::with_capacity(col.len(), col.dtype());
for i in 0..col.len() {
    builder.append_value(if i == row {
        json_to_anyvalue(&value, col.dtype())
    } else { col.get(i).unwrap_or(AnyValue::Null) });
}
let new_col = builder.finish(col_name);
df.replace_column(col_name, new_col)?;
```

**This is O(n) per cell edit** — Polars columns are immutable
chunked arrays; "edit cell" means "rebuild column with one
different value." For the redtable's contenteditable, that's
acceptable (one edit per blur), but a bulk "fill every null in
column X" is better expressed as `fill_nulls` (single rebuild)
than N `set_cell` calls (N rebuilds).

The frontend's edit-mode batching policy: debounce per cell, not
per file — so tab-through-five-cells produces five `set_cell` rows
(one undo per cell). That's the design.

### `fill_nulls` — value or forward-fill

```rust
match params["strategy"].as_str()? {
    "value" => {
        let v = json_to_anyvalue(&params["value"], col_dtype);
        col.fill_null_with_values(lit(v))
    }
    "forward" => col.forward_fill(None),
    other => return Err(InvalidSpec(format!("fill_nulls strategy: {other}"))),
}
```

**Forward-fill** holds state across the column scan (the "last
non-null value"). O(n). The `None` is the `limit` — `Some(k)`
would cap the forward-fill at k consecutive nulls; today's UI
doesn't expose the limit.

### `cast` — typed coercion

```rust
let target_dtype = match params["to"].as_str()? {
    "int"    => DataType::Int64,
    "float"  => DataType::Float64,
    "date"   => DataType::Date,
    "bool"   => DataType::Boolean,
    "string" => DataType::String,
    other    => return Err(InvalidSpec(format!("cast: {other}"))),
};
df.lazy()
  .with_column(col(col_name).cast(target_dtype))
  .collect()
```

**Strict cast** — failing values produce an error, not NULL.
This is intentional: a user wanting "best-effort cast, NULL on
failure" calls `fix_invalid` instead, which is the lenient cousin.

Date casts use Polars' default strptime — accepts `YYYY-MM-DD`
only. For other date layouts the workspace tooling proposes
`replace_text` first (rewrite to ISO), then `cast`.

### `fix_invalid` — lenient cast (NULL on failure)

```rust
let strict_expr = col(col_name).cast(target_dtype);
df.lazy()
  .with_column(strict_expr.fill_null(lit(NULL)))  // pseudo — see below
  .collect()
```

In practice this branches per dtype: for numeric, uses
`str_to_f64_or_null()` patterns; for dates, uses the multi-format
`parse_date_flex(column)` helper:

```rust
const FORMATS: &[&str] = &[
    "%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y",
    "%d-%m-%Y", "%d.%m.%Y", "%Y%m%d",
];
let exprs: Vec<Expr> = FORMATS.iter()
    .map(|f| col(column).str().to_date(StrptimeOptions {
        format: Some((*f).into()),
        strict: false, exact: true, cache: true,
    }))
    .collect();
coalesce(&exprs)
```

`coalesce` walks the list in order, returning the first
non-null result per row. Cells that match no format → NULL.

`parse_datetime_flex` is the same pattern with datetime layouts.

### `snake_case_columns` — header normalization

```rust
pub fn snake_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_lower_or_digit = false;
    for ch in s.trim().chars() {
        if ch.is_uppercase() && prev_lower_or_digit { out.push('_'); }
        match ch {
            ' ' | '-' | '.' | '/' => out.push('_'),
            c => out.extend(c.to_lowercase()),
        }
        prev_lower_or_digit = ch.is_lowercase() || ch.is_ascii_digit();
    }
    // Then: collapse runs of `__` to `_`, trim leading/trailing `_`.
    collapse_underscores(out)
}
```

**Idempotent** — applying twice produces the same result.
Verified by the workspace tooling: button doesn't disable after
first click; running it a second time is a no-op cost.

**Why this specific algorithm**: handles the common cases —
"Numero.dossier" → "numero_dossier", "Job Title" → "job_title",
"CamelCase" → "camel_case", "Price (HT)" → "price_ht" after a
parenthesis-strip pass (not yet wired; today produces
`price_(ht)`).

### `replace_in_names` / `replace_text` — find/replace

Both run `col.str().replace_literal(find, replace)` on the
relevant target (column names vs cell values). Literal, not
regex — UI exposes a "regex" checkbox for future work but the
engine path stays literal today.

Cost: O(n × avg_string_len) per column.

### `change_case` — lower/upper

```rust
match params["case"].as_str()? {
    "lower" => col.str().to_lowercase(),
    "upper" => col.str().to_uppercase(),
}
```

Polars built-ins. UTF-8 aware. Allocates a new column (no
in-place modification).

### `join_columns` — concat into new column

```rust
let from: Vec<&str> = params["from"].as_array()?.iter()
    .filter_map(|v| v.as_str()).collect();
let sep: &str = params["sep"].as_str().unwrap_or("");
let to: &str = params["to"].as_str()?;
let exprs: Vec<Expr> = from.iter().map(|c| col(c).cast(DataType::String)).collect();
df.lazy()
  .with_column(concat_str(exprs, sep, /*ignore_nulls*/ false).alias(to))
  .collect()
```

**`ignore_nulls = false`** — a single null in any source column
produces a null in the result. The workspace tooling proposes
`fill_nulls("")` first if the user wants graceful empty
substitution.

### `split_column` — split into many

```rust
let target_count = to.len();
let series_split: Series = col.str().split_inclusive(sep, target_count)?;
// Then: explode into N columns, drop the original.
```

Polars' `split` returns a list-column; we explode it to
`target_count` separate columns. If a row's value yields *fewer*
splits than `target_count`, the trailing columns are NULL. If
*more*, the surplus is concatenated into the last column (so no
data is lost).

### Cost of replay — what scales with what

| Step kind | Per-replay cost |
|---|---|
| `drop_columns`, `filter_columns`, `rename_column` | O(1) — alias change only |
| `drop_rows` (indices) | O(rows × indices_len) — see contains() note |
| `filter_rows` | O(rows × predicate_complexity) — par_iter under Polars |
| `unwrap_csv` | O(rows × col_count) — rare, only the wrapped-file path |
| `drop_nulls` | O(rows × col_subset) |
| `set_cell` | O(rows) — column rebuild |
| `fill_nulls` ("value") | O(rows) |
| `fill_nulls` ("forward") | O(rows) — sequential dependency, no par |
| `cast` | O(rows) per column |
| `snake_case_columns`, `replace_in_names` | O(col_count × avg_name_len) — column metadata only |
| `change_case`, `replace_text` | O(rows × avg_string_len) per column |
| `fix_invalid` (date variant) | O(rows × format_count) — 7 strptimes per cell worst case |
| `join_columns` | O(rows × from_count) |
| `split_column` | O(rows) — single split, then explode |

The expensive ones in practice: `fix_invalid` (especially on
non-date cells where all 7 strptimes fail) and `replace_text` on
wide columns. For a 100k-row file, `fix_invalid` on a single
column runs in ~50ms; 7-column fix_invalid runs in ~300ms.
Acceptable but it's the hot path if the user fix-invalid's
everything.

## Optimization map — where the cost lives

| Phase | Cost | Optimization horizon |
|---|---|---|
| `apply` per step (single) | varies — see table | per-kind; mostly fine |
| `replay` full history | O(n_steps × frame_ops) | snapshot point at ordinal N (`snapshot` endpoint exists; UI wiring TBD) |
| Cache hydrate (first read) | parse + replay + cache insert | one-shot per file lifetime; restart is rare |
| Cache invalidation (per mutation) | clears one DashMap entry | O(1); the read after pays the full hydrate |

**The current implicit assumption**: a file has tens of steps,
not hundreds. The replay cost is linear; at 100 steps × 10ms per
step = 1 second on the first read after invalidation. Users will
feel the click → 1s redraw lag at that scale.

**The lever**: snapshot points. `POST /api/files/:rid/snapshot`
materializes the current frame as a *new file* — but a future
in-place snapshot would set a marker in the steps history (e.g.
a `snapshot_marker` row) so replay starts from the marker's
stored frame and walks forward. Schema: add `materialized_frame
BYTEA NULL` to project_steps; nullable, written only when the
snapshot marker fires. Not built today; signaled at the head of
[step-apply-and-replay](../flows/step-apply-and-replay.md) as
performance horizon.
