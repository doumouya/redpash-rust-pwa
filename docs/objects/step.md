---
title: Step
section: Objects
order: 3
last modified date: 2026-05-30
---

# Step (`ProjectStep`)

**DTO:** `shared::step::ProjectStep`, `StepRequest`
**Table:** `project_steps`
**RID prefix:** `STP`
**Migration:** 001 init

---

## What a Step is

A Step is **one cleaning operation applied to a [File](file.md)** — drop a
column, fill nulls, recase headers, filter rows. RedPash never rewrites the
uploaded bytes: cleaning is modelled as an **append-only step log**, and a
file's "current view" is the base CSV with every *applied* step replayed in
`ordinal` order.

That makes undo / redo cheap and lossless — undo flips a step's `applied`
flag off, redo flips it back on; the row is never deleted, so the operation
can always be re-applied. See [file.md](file.md) for the File side of the
relationship.

---

## Fields

### `project_steps` table

| Field | DB column | Type | Nullable | Default | Description |
|---|---|---|---|---|---|
| `redpash_id` | `redpash_id` | `TEXT` PK | NO | — | `STP_…` |
| `file_redpash_id` | `file_redpash_id` | `TEXT` FK | NO | — | → `project_files.redpash_id` `ON DELETE CASCADE` |
| `ordinal` | `ordinal` | `INTEGER` | NO | — | Position in the file's step list. `MAX(ordinal)+1` on insert. |
| `kind` | `kind` | `TEXT` | NO | — | The operation — see [Step kinds](#step-kinds). |
| `params` | `params` | `JSONB` | NO | `'{}'::jsonb` | Per-kind parameters. |
| `applied` | `applied` | `BOOLEAN` | NO | `TRUE` | `FALSE` = undone, still in the redo stack. |
| `created_at` | `created_at` | `TIMESTAMPTZ` | NO | `now()` | |

**Index:** `project_steps_file_idx` on `(file_redpash_id, ordinal)` — the
step list is always read `ORDER BY ordinal ASC`.

### `ProjectStep` DTO (over the wire)

```rust
pub struct ProjectStep {
    pub redpash_id:      String,
    pub file_redpash_id: String,
    pub ordinal:         i32,
    pub kind:            String,            // see Step kinds
    pub params:          serde_json::Value, // per-kind shape
    pub applied:         bool,              // false = undone
    pub created_at:      DateTime<Utc>,
}
```

`kind` is a plain `String`, not an enum — a new step kind can ship without
touching the DTO; the `data` crate pattern-matches the known values and
rejects the rest. `params` is a free-form JSON value for the same reason:
each kind needs a different shape.

### `StepRequest` DTO (request body)

```rust
pub struct StepRequest {
    pub kind:   String,
    pub params: serde_json::Value,
}
```

Body of `POST /api/files/:rid/steps`. The backend assigns `redpash_id`,
`ordinal`, `applied` and `created_at` — the caller supplies only the
operation.

---

## Step kinds

18 kinds, dispatched by `data::steps::apply` (and `replay` for the
cache-miss rebuild) — see the `data/src/steps/` module
([`mod.rs`](../../backend/crates/data/src/steps/mod.rs) is the
dispatcher; per-family implementations live in `rows.rs` / `columns.rs`
/ `cells.rs` / `structure.rs` / `util.rs`).
Grouped by what they mutate:

**Column-shape (7):** `drop_columns` · `filter_columns` (keep listed) ·
`rename_column` · `snake_case_columns` · `replace_in_names` ·
`join_columns` · `split_column`

**Row-shape (3):** `drop_rows` (absolute index) · `drop_nulls` ·
`filter_rows` (predicate tree, 17 ops)

**Cell-value (7):** `set_cell` · `fill_nulls` · `cast` (with
`/cast-preview` dry-run) · `change_case` · `replace_text` · `fix_invalid`
(sentinel replace) · `format_dates`

**Rescue (1):** `unwrap_csv` (re-parse a fully-quoted CSV)

The authoritative per-kind **`params` shapes** live in the
[Step kinds section of api/files.md](../api/files.md#step-kinds) and in the
per-family file docstrings under `data/src/steps/` — not duplicated here.

---

## Lifecycle

```
Apply   POST /api/files/:rid/steps   { kind, params }
        └─ validate against the cached frame
           └─ insert_step  (ordinal = MAX+1, applied = true)
              └─ a new step clears the redo stack:
                 DELETE FROM project_steps WHERE applied = false

Undo    POST /api/files/:rid/undo
        └─ undo_last — flip the last applied step to applied = false

Redo    POST /api/files/:rid/redo
        └─ redo_next — flip the first un-applied step back to true

Replay  on cache-miss hydrate
        └─ data::steps::replay(base_df, [(kind, params), …])
           rebuilds the current view from the base CSV + applied steps
```

A step is **only persisted after it validates** against the live frame — a
bad `kind` or malformed `params` is a `400`, never a stored-but-broken row.
Undo / redo never delete rows: the history is the full operation log and
the `applied` flag is the cursor into it. A fresh step INSERT branches from
the live cursor, so it clears any un-applied (redo-stack) steps first.

---

## DB helpers (`crates/api/src/db/mod.rs` — steps section)

| Helper | Purpose |
|---|---|
| `list_steps(file_rid)` | All steps in `ordinal` order — applied + undone |
| `insert_step(file_rid, kind, params)` | Append a step; clears the redo stack first |
| `undo_last(file_rid)` | Flip the top applied step to `applied = false` |
| `redo_next(file_rid)` | Flip the first un-applied step back to `true` |
| `clear_steps_of_kind(file_rid, kind)` | Surgically un-apply every step of one `kind` — powers `/clear-filters`; rows stay, redo won't pick them up |

---

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/files/:rid/steps` | Apply a step — body `StepRequest { kind, params }` |
| POST | `/api/files/:rid/undo` · `/redo` | Walk the step cursor |
| POST | `/api/files/:rid/clear-filters` | `clear_steps_of_kind(rid, "filter_rows")` — the eraser button |
| POST | `/api/files/:rid/cast-preview` | Dry-run a `cast` step before committing it |

Steps also ride along in `GET /api/files/:rid` — the `FileEnvelope`
returns `steps: Vec<ProjectStep>` so the cleaner renders the history on
load. See [api/files.md](../api/files.md) for the full endpoint detail.

---

## Notes

- **No standalone step endpoint.** Steps are always addressed through
  their parent file (`/api/files/:rid/…`); the `STP_…` RID is an internal
  PK, never a URL segment.
- **Steps cascade with the file.** `file_redpash_id` is `ON DELETE
  CASCADE` — deleting a File drops its whole step history.
- **`drop_rows` vs `set_cell`.** `drop_rows` removes whole rows by
  absolute index; `set_cell` with `value: null` clears a single cell to
  NULL. Both are ordinary steps — both undoable.
