---
title: Step apply + replay
section: Internal
order: 42
last modified date: 2026-05-24
status: filled
---

# Flow: Step apply + replay

User clicks a cleaning tool in the workspace → step persisted →
cache invalidated → next read replays from base + reflects the new
step. The original file bytes never change.

## The trace — apply path

1. **User**: clicks a tool button in the workspace tools panel
   (one of the 12 buttons via `defineTool` in
   `frontend/scripts/tools.js`).
2. **Frontend** (`workspace.js::applyStep(kind, params)`):
   single-flight gate (drops the call if an apply is in
   progress), updates the rowsInfo status to "applying…", builds
   the body `{ kind, params }`.
3. **api.js**: POST `/api/files/:rid/steps`.
4. **Route** (`routes::files::add_step`):
   - `resolve_user_rid(state, headers)` → caller's RID.
   - `ensure_owner(db::file_owner(...), &caller, "file", rid)`
     → 404 if not theirs.
   - `hydrate(state, &rid)` — ensures the cached DataFrame
     reflects all currently-applied steps. Cache hit = instant.
5. **Pre-flight** — call `data::steps::apply(df.clone(), kind,
   &params)`. If it errors, return 400 with
   `kind="invalid_spec"` and the engine's message. Never
   persist a step we know will fail on replay.
6. **Persist** — `INSERT INTO project_steps (file_redpash_id,
   ordinal, kind, params, applied=true)` with
   `ordinal = (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM
   project_steps WHERE file_redpash_id = $1)`.
7. **Trigger** — `project_steps_bump_file` (`AFTER
   INSERT/UPDATE/DELETE FOR EACH ROW`) calls
   `bump_file_mtime_from_step()` which UPDATEs
   `project_files.updated_at = now()` for the parent file.
   Cheap single-row update; fires for every history change.
8. **Cache invalidate** — `state.files.remove(&rid)` evicts the
   hydrated DataFrame. The next read re-replays from the base.
9. **Response** — the new `shared::step::ProjectStep` row.
10. **Frontend**: optimistic UI update (row appended to the
    visible step timeline) + a `refetchPage()` to redraw the
    table with the new state.

`set_cell` (cell edit) and `drop_rows` (row delete via select
mode) go through the same `applyStep` helper — they're just
specific `kind`s, no separate endpoint.

## The replay path — next read

On any subsequent `/api/files/:rid/page` (or any other endpoint
that touches the DataFrame):

1. `hydrate(state, &rid)` is called.
2. **Cache hit?** Return the cached `Arc<DataFrame>`. Done.
3. **Cache miss** (just invalidated, or server restart):
   - `tokio::fs::read(state.file_path(&rid))` → raw bytes.
   - `data::parse::*` parses to a base DataFrame (Polars
     `CsvReader` / `calamine` / etc. per the file's extension +
     encoding).
   - `db::list_steps_applied(&pool, &rid)` →
     `Vec<(kind, params)>` ordered by ordinal ASC. Filters by
     `applied=true` — undone steps are invisible to replay.
   - `data::steps::replay(base, &steps)`:
     ```rust
     let mut df = base;
     for (kind, params) in steps {
         df = data::steps::apply(df, kind, params)?;
     }
     Ok(df)
     ```
   - Result wrapped in `Arc` and inserted into
     `state.files.insert(rid, df)`.
4. The page query (`?page=&size=&filters=&sort=&q=`) is applied
   on top via `data::parse::apply_filter` /
   `apply_sort` — these are *query-time* operations, not
   persisted steps. They shape the response only and don't
   touch `project_steps`.
5. Page returned.

## Undo

```
POST /api/files/:rid/undo
```

1. Find the topmost applied step:
   ```sql
   UPDATE project_steps SET applied = false
    WHERE redpash_id = (
      SELECT redpash_id FROM project_steps
       WHERE file_redpash_id = $1 AND applied = true
       ORDER BY ordinal DESC LIMIT 1)
   ```
2. Trigger bumps file mtime; cache invalidates.
3. Response returns the rebuilt file envelope (summary +
   columns + steps list — the undone step is in the list but
   `applied=false`).
4. Next read replays *without* the undone step.

The row is **not deleted** — the user's step history panel still
shows it, greyed out. Redo flips it back.

## Redo

```
POST /api/files/:rid/redo
```

1. Find the bottommost `applied=false` step that sits above all
   currently-applied steps:
   ```sql
   UPDATE project_steps SET applied = true
    WHERE redpash_id = (
      SELECT redpash_id FROM project_steps
       WHERE file_redpash_id = $1
         AND applied = false
         AND ordinal > COALESCE(
               (SELECT MAX(ordinal) FROM project_steps
                 WHERE file_redpash_id = $1 AND applied = true),
               0)
       ORDER BY ordinal ASC LIMIT 1)
   ```
2. Same trigger + cache invalidate.

## Branching ambiguity (UX debt)

Applying a new step **after an undo** doesn't currently discard
the previously-undone tail. The new step gets the next ordinal,
sitting in history alongside the still-undone rows. A `redo`
after this state silently re-applies on top of the new step —
not what most users expect.

Either:

- The workspace UI buries the redo affordance after a new apply
  (today's behavior — frontend tracks this and disables redo).
- The API deletes the undone tail on new apply
  (`DELETE FROM project_steps WHERE file_redpash_id = $1
  AND applied = false AND ordinal > <new_step_ordinal>`).

Option B is the long-term fix. Tracked.

## Snapshot

`POST /api/files/:rid/snapshot` materializes the
currently-replayed DataFrame as a **new file row** with its own
`redpash_id` + a fresh bytes blob. The original file + its step
history are untouched; the snapshot starts with zero steps.

Use case: "fork this cleaning state and try a different
direction." Real file = real URL = can diverge freely. Doesn't
participate in replay of the original.

## Performance notes

- **Replay cost is linear in step count.** For a file with 50
  steps, every cache miss replays all 50. Acceptable at current
  scale; revisit with a snapshot point if step counts climb
  (snapshot = materializing a checkpoint mid-history so replay
  starts from there). The snapshot endpoint above is the
  primitive — UI for it doesn't exist yet.
- **The cache is per-process.** A multi-instance deployment
  needs either a shared in-memory store (Redis, etc.) or
  per-instance cache + a snapshot strategy. Solo-dev today; not
  a present problem.
- **`hydrate` is async** (the file read is) but `replay` is
  sync. A long replay holds a tokio runtime thread for its
  duration. `spawn_blocking` if individual replays push past
  100ms.

## Cross-refs

- 17 step kinds + per-kind params shape:
  [step-engine](../subsystems/step-engine.md).
- DataFrame model + parse path + auto_clean:
  [data-engine](../subsystems/data-engine.md).
- `project_steps` schema + indices:
  [monitoring-schemas](../specs/monitoring-schemas.md) §5.
- Query-time filter / sort DTO:
  [filter-dto](../specs/filter-dto.md).
- JS / Rust boundary contract — why steps live in Rust:
  [js-rust-boundary](../architecture/js-rust-boundary.md).
