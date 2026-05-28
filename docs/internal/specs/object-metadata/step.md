---
title: Step — object metadata
section: Internal
order: 46
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Step (STP_)

One cleaning operation applied to a csv-typed File — the append-only
unit of the cleaner's undo/redo history. 18 step kinds today,
dispatched in `data::steps::apply` (see [file](file.md#supported-calls)
for the wire). Steps don't get individually patched or deleted:
undo flips `applied = false`, redo flips it back, and the cleaner
cursor is the live head of the applied chain.

**Backing table:** `project_steps` (migration `20260512000001_init.sql`).
**DTO:** `backend/crates/shared/src/step.rs` (`ProjectStep` +
`StepRequest`).
**Routes:** `backend/crates/api/src/routes/files/mod.rs` (the
mutating endpoints — `POST /:rid/steps` + `POST /:rid/{undo,redo}`).
`backend/crates/api/src/routes/admin.rs` carries the paginated
read-only list for the Home Steps tab.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/files/:rid/steps` | Body: `StepRequest { kind, params }`. Server assigns `STP_<32hex>` + the next `ordinal` for the file. Step is appended at `applied = true`; any un-applied (redo-stack) steps that the file had get cleared first. Returns the rebuilt FileEnvelope. Owner-gated through the file. Emits `step_apply`. |
| `read` | — | **Not supported as a standalone call.** Steps are surfaced as the `steps[]` array on the FileEnvelope (the GET /api/files/:rid response). No `/api/steps/:rid` endpoint. |
| `update` | — | **Not supported.** Steps are immutable post-create. Re-applying a step with different params means appending a new step + leaving the old one in the un-applied tail. |
| `delete` | — | **Not supported as a user-facing call.** Steps disappear only via `DELETE /api/files/:rid` (CASCADE) or via the `/clear-filters` surgical un-apply (which flips `applied = false` for the matching kind, not a delete). |
| `undo` | `POST /api/files/:rid/undo` | Walks the cursor back one step — flips the active step to `applied = false`. Cached frame rebuilt; rebuilt FileEnvelope returned. NOT a step DELETE — the row stays. |
| `redo` | `POST /api/files/:rid/redo` | Walks the cursor forward — flips the next `applied = false` step back to true. Returns the rebuilt FileEnvelope. |
| `clear-filters` | `POST /api/files/:rid/clear-filters` | Surgical un-apply: flips every `filter_rows` step on the file to `applied = false` (eraser button). Other kinds are untouched. Other surgical-clears (`clear-cleanness`) operate on stats, not steps. |
| `list (admin)` | `GET /api/admin/steps?page&size&file&kind&applied&q` | Paginated `Page<StepSummary>` for the Home Steps tab. JOINs project_steps + project_files (for the filename column). Filters: `file=` (per-file slice), `kind=` (per-kind slice), `applied=true|false` (head vs tail). |
| `search` | `GET /api/admin/steps?q=…` | ILIKE substring on `kind` + the joined `project_files.filename` (only on the admin endpoint). |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format STP_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("STP").
               Hidden by default in the Home Steps tab.
```

```
file_redpash_id
  Type:        TEXT NOT NULL / String — FK to project_files.redpash_id
  Properties:  Layout
  Description: The file this step targets. NOT a Create-property
               directly — the path parameter on POST /api/files/:rid/steps
               supplies it. CASCADE on file delete (deleting a file
               drops its step history). Composite index
               (file_redpash_id, ordinal) is the canonical lookup
               path.
```

```
ordinal
  Type:        INTEGER NOT NULL / i32
  Properties:  Layout
  Description: Position in the file's step history (0-indexed,
               server-assigned). The cleaner replay reads steps in
               ordinal ASC order. Re-using an ordinal (e.g. on
               redo-after-cleared-tail) is allowed because the new
               step replaces the cleared-tail one ordinal-wise.
```

```
kind
  Type:        TEXT NOT NULL / String
  Properties:  Create, Search, Layout
  Description: The step kind — drives the replay dispatch in
               data::steps::apply. 18 known kinds today, grouped:
                 column-shape (7) — drop_columns / filter_columns
                   (keep) / rename_column / snake_case_columns /
                   replace_in_names / join_columns / split_column
                 row-shape (3) — drop_rows / drop_nulls / filter_rows
                 cell-value (7) — set_cell / fill_nulls / cast /
                   change_case / replace_text / fix_invalid /
                   format_dates
                 rescue (1) — unwrap_csv
               Unknown kinds are rejected by the data crate (clean
               400 rather than a silent no-op). No DB CHECK
               constraint — the application enforces the allow-list.
```

```
params
  Type:        JSONB NOT NULL DEFAULT '{}' / serde_json::Value
  Properties:  Create
  Description: Kind-specific parameters. Shape varies per kind
               (see the per-kind docstrings under
               data/src/steps/). Examples: drop_columns →
               { cols: [<name>...] }; cast → { col, dtype };
               filter_rows → { spec: <FilterNode tree> }.
```

```
applied
  Type:        BOOLEAN NOT NULL DEFAULT TRUE / bool
  Properties:  Sort, Layout
  Description: The cleaner cursor state. true = step is in the
               applied chain (rebuilt frame includes its effect).
               false = step is in the un-applied tail (redo-able).
               Mutated by /undo + /redo + /clear-filters — never
               by direct client write. Surfaced on the Home Steps
               tab so the admin view can see the head/tail split.
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Layout
  Description: Append timestamp. Step history is created-at-ASC
               same as ordinal-ASC.
```

---

## Enum constraints

`kind` has **no DB-side CHECK** today (free-text TEXT NOT NULL). The
application enforces the 18-value allow-list at the entry point —
unknown kinds in POST /api/files/:rid/steps fail in
`data::steps::apply` with a clean 400. RBAC will codify the kind
allow-list as a permission-key axis when permissions ship (e.g. a
read-only role can use `filter_rows` + `drop_columns` but not
`set_cell` — kind granularity is the natural slice).

The kind set:

```
column-shape (7) — drop_columns, filter_columns (keep listed),
                   rename_column, snake_case_columns,
                   replace_in_names, join_columns, split_column
row-shape (3)   — drop_rows (absolute index), drop_nulls,
                   filter_rows (predicate tree, 16 ops)
cell-value (7)  — set_cell, fill_nulls, cast (with /cast-preview
                   dry-run), change_case, replace_text, fix_invalid
                   (sentinel replace), format_dates
rescue (1)      — unwrap_csv (re-parse a fully-quoted CSV)
```

Authoritative per-kind param shapes live in the per-family files
under `backend/crates/data/src/steps/` (`rows.rs` / `columns.rs` /
`cells.rs` / `structure.rs` / `util.rs`).

---

## Relationships

```
file_redpash_id → File (FIL_, csv-typed)
  Cardinality:  N:1 (a File has many Steps)
  On delete:    CASCADE (deleting the file drops its step history;
                step.params alone can't reconstruct the file's
                history without the source frame)
  Hydrated as:  — (on the FileEnvelope.steps[] array; admin list
                surfaces filename via the JOIN)
```

### Inverse relationships

```
(none) — Steps don't own any sub-rows.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `step_apply` | `POST /api/files/:rid/steps` | `{ file, kind, step }` |

Undo / redo / clear-filters do **not** emit events today (the cursor
move is considered cleaner-internal — the file_patch event covers
the user-visible "file changed" signal when the rebuilt envelope's
columns differ). Worth a follow-up if the activity feed grows to
surface per-step undo/redo history; today the canonical undo log is
the per-file step list itself (`applied` flag does the walk).

`/clear-filters` similarly emits nothing — the filter UI is the
visible signal that the eraser fired. RBAC may want this audited
later (mass un-apply is a coarser action than per-step undo).
