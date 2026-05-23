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

Source of truth: `backend/crates/data/src/steps.rs` (the dispatch
match arm) + `backend/crates/api/src/routes/files.rs` (the apply /
undo / redo / snapshot endpoints).

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
  see [wasm-engine](wasm-engine.md) §3.
