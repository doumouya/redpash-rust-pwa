---
title: CSV upload → render
section: Internal
order: 41
last modified date: 2026-05-24
status: stub
---

# Flow: CSV upload → render

> **TODO.** Fill after a real debugging pass through the upload path.

The full path traced:

1. **User**: clicks the rail-foot "Upload file" button → hidden `<input type="file">` → file picked
2. **Frontend** (`workspace.js`): builds `FormData` with `file` + optional `project_name` (from active group)
3. **api.js**: detects `FormData` instance → skips JSON encoding → POST `/api/files/upload`
4. **Server** (`routes/files.rs#upload`): multipart parse → 256 MiB cap → `is_excel_filename` check
5. **Excel branch**: `data::parse::xlsx_to_csv` (spawn_blocking) — converts to CSV bytes before disk
6. **Storage**: bytes written to `state.file_path(&rid)` (config-driven path); DB row inserted; project ensured (find-or-create by name)
7. **Cleanness compute**: `data::stats::compute_cleanness` runs over the bytes; result persisted
8. **Response**: `FileEnvelope { summary, columns, steps: [] }`
9. **Frontend** (`refreshAndOpen`): claims `activeFileRid` → `loadProjects()` rebuilds rail → expand target group → `loadFilesForGroup` → find new tab → `loadFile(newRid)` fetches the page
10. **Render**: `fetchAndRender` POST → table populated, pager set, sort headers synced

To document:

- Why `activeFileRid` is claimed before `loadProjects` (race with default-group auto-open)
- The Excel branch's perf characteristic (whole-file in memory)
- Cleanness compute as a side-effect of upload — implications for retry behaviour
