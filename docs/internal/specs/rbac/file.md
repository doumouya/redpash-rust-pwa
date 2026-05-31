---
title: File — permission catalog
section: Internal
order: 55
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# File (FIL_) — permissions

Permission keys + default grant matrix for the File object — the
canonical `project_files` row (csv-typed; chart/dashboard kinds get
their own catalog docs since the wire differs). Derived from
[file metadata](../object-metadata/file.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches File supports:** `project_redpash_id` → `@project` +
(transitively) `@own` (the project's owner) + `@company` (the
project's company). A File has no `owner_id` of its own — ownership
flows **User → Project → File**, so File's `own` reach resolves to "the
caller owns (holds a membership on) the File's project." `all` =
platform admin. All four reaches own/project/company/all apply.

The data-bearing operations (upload, paged rows, cleaning steps,
joins, snapshots, exports) all gate on the same view — if you can
view the File you can page its rows; if you can update it you can
apply steps. Step application is specced on [Step](step.md).

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `file.view` — the
reach decides *which* files the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `file.view` | the file (summary / list / search + paged rows + dedup/uniques/sentinels/cast-preview probes + one-shot export) | own · project · company · all | `own` = the caller owns (holds a membership on) the file's project; one key covers the whole data-inspection + export surface |
| `file.view.all` | every file | all | platform admin |
| `file.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per editable field: `project` · `display_name` · `encoding` · `delimiter` (+ read-only `filename`, computed `stage`/`cleanness_pct`/`row_count`/…, `created_at`, …). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `file.view.field.all` | every field | own · project · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `file.create` | object `file.view` | — (no row yet) | Upload (CSV + Excel auto-convert) via `POST /api/files/upload`; lands in the caller's named/default project. `filename` stem + `file_type` (csv) set server-side at upload |
| `file.project.update` | `file.view.field.project` | own · company · all | **Move** the file between projects (`project_redpash_id`). Double-gated — the destination project must also be writable by the caller (enforcement checks both ends) |
| `file.display_name.update` | `…field.display_name` | own · project · company · all | Rename (the editable cell) |
| `file.encoding.update` | `…field.encoding` | own · project · company · all | Re-decode override |
| `file.delimiter.update` | `…field.delimiter` | own · project · company · all | |
| `file.delete` | `file.view.field.all` | own · company · all | `DELETE /api/files/:rid` — cascade history + reports, unlink blob. Not project-viewers |

**No atoms for:** `redpash_id`, `filename` (stem, set at upload from
the original name — not re-settable; `display_name` is the editable
label), `file_type` (set at create by the kind), computed `stage` /
`cleanness_pct` / `row_count` / `col_count` / `file_size_bytes` (all
derived / server-set), `created_at`, `updated_at`.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `file-mem` —
a bare project membership (no company role), which resolves at `own` /
`project`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | file-mem |
|---|---|---|---|---|---|---|
| `file.view` | all | company | company | company | company | project |
| `file.view.field.all` | all | company | company | company | company | project |
| `file.create` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `file.display_name.update` | all | company | company | — | — | project |
| `file.encoding.update` | all | company | company | — | — | project |
| `file.delimiter.update` | all | company | company | — | — | project |
| `file.project.update` | all | company | company | — | — | own |
| `file.delete` | all | company | — | — | — | own |

Reading the matrix: a project member (`file-mem`) views every file in
their project (whole records), can upload, and run the cleaning
pipeline (display-name / encoding / delimiter), but can only move
(`file.project.update`) or delete files in a project they *own* — the
`own` reach. A **company member** views every file in their company
(whole records) but can't mutate; a **company viewer** views only. A
**company admin** has full field control over company-project files
except deletion. **Delete** needs `view.field.all` + the delete atom:
project-owner / company-owner / platform-admin only.

---

## 3. Notes

- **File `own` reach = project ownership.** No `files.owner_id` column —
  the live `ensure_owner` for files resolves the file's project's
  owner. So `file.view@own` means "you own the project this file is in."

- **One view atom covers the whole data surface.** `/page`, `/dedup`,
  `/uniques`, `/sentinels`, `/cast-preview` are all "inspect this
  file's data" — they share `file.view`, not per-endpoint atoms.
  Splitting would over-fragment the catalog with no policy benefit (you
  either see the file's data or you don't).

- **`file.*.update` covers the cleaning pipeline.** Apply-step / undo /
  redo / clear-filters / set-encoding / snapshot all mutate the file's
  derived state → gated by the matching field-view's derived update
  (set-encoding ⇐ `file.encoding.update`; the rest of the pipeline ⇐
  the editable-field updates). [Step](step.md) keys describe the step
  operations themselves but inherit this scope.

- **Export is view-equivalent.** `GET /api/files/:rid/export` (one-shot
  csv/xlsx/json download, no DB write) is covered by `file.view` —
  exporting is just reading into a download. No separate atom today; a
  future "can view but not download" policy (DLP-style) would split one
  off as a hook.

- **Move (`file.project.update`) is double-gated.** The caller needs
  write on both the source file AND the destination project —
  enforcement checks the destination separately. Viewers can't move (no
  write).

- **`is_public` files.** A file flagged `is_public` widens its `view`
  reach to any authenticated caller (read + export) regardless of
  project membership; it does **not** widen any write or delete atom —
  public is a view-only broadening, mutate/delete still resolve through
  the normal project-ownership reaches.

- **`source_file_id` lineage outlives deletes.** A derived file's
  `source_file_id` points at its origin; the link is a soft FK retained
  for audit, so deleting the source doesn't cascade-strip the lineage
  pointer. Viewing a derived file is gated by *its own* reach, not the
  source's — a caller can hold a derived file without view on its
  origin.

- **Chart / dashboard kinds split off.** A `project_files` row with
  `file_type='chart'|'dashboard'` is specced in [chart](chart.md) /
  [dashboard](dashboard.md) — same scope columns, different atoms (the
  wire contract differs per kind). This doc scopes `file_type='csv'`.

- **Today everything resolves `all`.** Dev-permissive:
  `resolve_user_rid` yields the dev_user, which the enforcement layer
  will treat as `plat:admin` until real platform roles ship. This matrix
  is the target the enforcement slice checks against — it changes no
  runtime behavior on its own.
