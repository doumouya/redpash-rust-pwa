---
title: CSV upload → render
section: Internal
order: 41
last modified date: 2026-05-24
status: filled
---

# Flow: CSV upload → render

User picks a file in the workspace rail-foot → bytes land on disk +
a `project_files` row + a hydrated DataFrame in cache → the
redtable renders the first page.

## The trace

1. **User**: clicks the rail-foot "Upload file" button → hidden
   `<input type="file">` → file picked.
2. **Frontend** (`workspace.js`): builds `FormData` with `file`
   + optional `project_name` (from active group).
3. **api.js**: detects `FormData` instance → skips JSON encoding →
   POST `/api/files/upload` with the multipart body.
4. **Outer middleware**: `request_id_mw` mints `req_<uuid>` →
   `capture_mw` snapshots `Instant::now()` → `DefaultBodyLimit`
   gates at 256 MiB.
5. **Route** (`routes::files::upload`): `axum::extract::Multipart`
   stream → reads `filename` field + bytes field. Resolves caller
   via `super::resolve_user_rid`.
6. **Excel branch** (`is_excel_filename(name)`): runs
   `tokio::task::spawn_blocking(move || data::parse::xlsx_to_csv(&bytes))`
   to convert .xlsx → CSV bytes off the runtime. Result replaces
   the multipart bytes for subsequent steps.
7. **Storage**: `state.file_path(&rid)` resolves
   `REDPASH_DATA_DIR/files/<rid>.bin` → `tokio::fs::write` lands
   the bytes.
8. **DB**: project ensured via `db::find_or_create_project(name)`;
   `db::insert_file(rid, project_rid, filename, …)` inserts the
   `project_files` row.
9. **Hydrate + auto_clean**: `routes::files::hydrate(state, &rid)`
   parses the bytes via [data-engine](../subsystems/data-engine.md)
   `parse::*` → runs `clean::auto_clean(df)` → caches the
   `Arc<DataFrame>` on `state.files` (a DashMap keyed by RID).
10. **Stats**: `data::stats::compute_cleanness(&df)` →
    `UPDATE project_files SET cleanness_pct = $2, row_count = $3,
    col_count = $4 WHERE redpash_id = $1`. Side effect of upload
    — see "retry behavior" below.
11. **Capture middleware**: `request_log::record(method, route,
    status, duration_ms, request_id)` (fire-and-forget). 4xx/5xx
    → `event::record(kind="http_error", …)` too. See
    [events-and-logs](../subsystems/events-and-logs.md).
12. **Response**: `FileEnvelope { summary, columns, steps: [] }`
    — `summary` is the `FileSummary` DTO; `columns` is the
    `Vec<ColumnMeta>` from `dtype::summarize`.
13. **Frontend** (`workspace.js::refreshAndOpen`): claims
    `activeFileRid = newRid` *before* the next call, so the
    default-group auto-open doesn't race past it. Then
    `loadProjects()` rebuilds the rail; `loadFilesForGroup`
    refreshes the target group; the new tab gets focus.
14. **First page fetch**: `loadFile(newRid)` → `GET /api/files/:rid`
    (file summary + columns) + `GET /api/files/:rid/page?…`
    (rows) in parallel.
15. **Render**: `fetchAndRender` populates the redtable;
    pager set; sort headers synced.

## Notes

- **`activeFileRid` claim order matters.** It's set *before*
  `loadProjects` because the rail rebuild's default-group logic
  auto-opens the group's first file otherwise — racing the upload's
  intended file. Race documented inline at the `refreshAndOpen`
  call site; don't reorder without re-reading the comment.
- **Excel branch is in-memory.** `xlsx_to_csv` deserializes the
  whole workbook (`calamine` doesn't stream). A 256 MiB xlsx will
  push the runtime past memory pressure. `spawn_blocking` keeps
  the async runtime healthy but the whole bytes are still on the
  heap during convert.
- **Cleanness compute is a side effect of upload.** If the upload
  succeeds but the cleanness UPDATE fails (transient DB), the
  row exists with `cleanness_pct=NULL`. The user sees the file
  but the workspace pre-import strip shows "—" instead of a
  number. Idempotent fix: a separate `POST /api/files/:rid/recompute`
  endpoint (not yet built) or just re-upload.
- **Hydrate cache is in-process memory.** A server restart drops
  it; the next read re-parses + re-replays. Acceptable today
  because the workspace warms only the file being viewed. If the
  app ever pre-warms many files on boot, this becomes a real cost.
- **No transactional guarantee** across the four side-effects
  (bytes write, file row insert, cleanness UPDATE, hydrate
  cache). If the row insert fails after bytes are on disk, the
  bytes leak (gitignored on dev, real cost in prod). Mitigation:
  `state.file_path(&rid)` uses the RID as the filename, so an
  orphaned file is identifiable; sweeper TBD.

## Cross-refs

- Upload route + body limits: [api-routes](../subsystems/api-routes.md).
- xlsx_to_csv, parse path, auto_clean: [data-engine](../subsystems/data-engine.md).
- The hydrate cache + cache invalidation: [step-engine](../subsystems/step-engine.md).
- request_log + events capture: [events-and-logs](../subsystems/events-and-logs.md).
