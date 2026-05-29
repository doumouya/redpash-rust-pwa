---
title: File — permission catalog
section: Internal
order: 55
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# File (FIL_) — permissions

Permission keys + default grant matrix for the File object — the
canonical `project_files` row (csv-typed; chart/dashboard kinds get
their own catalog docs since the wire differs). Derived from
[file metadata](../object-metadata/file.md); scheme in the
[catalog template](index.md).

**Scope columns File carries:** `project_redpash_id` → `@project` +
(transitively) `@own` (the project's owner) + `@company` (the
project's company). A File has no `owner_id` of its own — ownership
flows **User → Project → File**, so File's `@own` resolves to "the
caller owns the File's project." `@all` = platform admin.

The data-bearing operations (upload, paged rows, cleaning steps,
joins, snapshots, exports) all gate on the same scope — if you can
read the File you can page its rows; if you can update it you can
apply steps. Step application is specced on [Step](step.md).

---

## 1. Keys

### Object-action keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `file.create` | `POST /api/files/upload` | — | Upload (CSV + Excel auto-convert). Lands in the caller's named/default project. |
| `file.read` | `GET /api/files/:rid` (summary) + `/page` (rows) | own · project · company · all | One key covers summary + paged rows + dedup/uniques/sentinels probes — they're all "look at this file's data." |
| `file.update` | `PATCH /api/files/:rid` + steps/undo/redo/snapshot/encoding | own · project · company · all | Coarse mutate gate — display-name/move/encoding + the cleaning pipeline (steps live on [Step](step.md), gated by this). |
| `file.delete` | `DELETE /api/files/:rid` | own · company · all | Cascade history + reports; unlink blob. Not project-viewers. |
| `file.list` | `GET /api/files` + per-project + admin | own · project · company · all | |
| `file.export` | `GET /api/files/:rid/export` | own · project · company · all | One-shot download (csv/xlsx/json), no DB write. Same scope as read — exporting is reading. |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `file.project_redpash_id.update` | `project_redpash_id` | own · company · all | **Move** the file between projects. The destination must also be writable by the caller (enforcement checks both ends). |
| `file.display_name.update` | `display_name` | own · project · company · all | Rename (the editable cell). |
| `file.encoding.update` | `encoding` | own · project · company · all | Re-decode override. |
| `file.delimiter.update` | `delimiter` | own · project · company · all | |

**No keys for:** `redpash_id`, `filename` (stem, set at upload from
the original name — not re-settable; `display_name` is the editable
label), `file_type` (set at create by the kind), computed `stage` /
`cleanness_pct` / `row_count` / `col_count` / `file_size_bytes` (all
derived/server-set), `created_at`, `updated_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `file.create` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `file.read` | all | company | company | company | project | project | own |
| `file.list` | all | company | company | company | project | project | own |
| `file.export` | all | company | company | company | project | project | own |
| `file.update` | all | company | company | — | project | — | own |
| `file.delete` | all | company | — | — | — | — | own |
| `file.project_redpash_id.update` | all | company | company | — | — | — | own |
| `file.display_name.update` | all | company | company | — | project | — | own |
| `file.encoding.update` | all | company | company | — | project | — | own |
| `file.delimiter.update` | all | company | company | — | project | — | own |

Reading it: the project owner has full control of files in their
project (`@own`); a project collaborator (v3) can upload, read,
export, and run the cleaning pipeline but can't delete or move files
across projects; a viewer reads + exports but can't mutate; company
admins manage company-project files but can't delete; deletion is
owner / company-owner / platform-admin only.

---

## 3. Notes

- **File `@own` = project ownership.** No `files.owner_id` column —
  the live `ensure_owner` for files resolves the file's project's
  owner. So `file.read@own` means "you own the project this file is in."

- **One read key covers the whole data surface.** `/page`, `/dedup`,
  `/uniques`, `/sentinels`, `/cast-preview` are all "inspect this
  file's data" — they share `file.read`, not per-endpoint keys. Splitting
  would over-fragment the catalog with no policy benefit (you either
  see the file's data or you don't).

- **`file.update` covers the cleaning pipeline.** Apply-step / undo /
  redo / clear-filters / set-encoding / snapshot all mutate the file's
  derived state → all gated by `file.update`. [Step](step.md) keys
  describe the step operations themselves but inherit this scope.

- **`file.export` is read-equivalent.** Same scope as `file.read` —
  exporting is just reading into a download. Split into its own key
  only so a future "can view but not download" policy (DLP-style) has
  a hook; today they always travel together.

- **Move (`file.project_redpash_id.update`) is double-gated.** The
  caller needs write on both the source file AND the destination
  project — enforcement checks the destination separately. Viewers
  can't move (no write).

- **Chart / dashboard kinds split off.** A `project_files` row with
  `file_type='chart'|'dashboard'` is specced in [chart](chart.md) /
  [dashboard](dashboard.md) — same scope columns, different action
  keys (the wire contract differs per kind).
