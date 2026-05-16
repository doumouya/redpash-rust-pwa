---
title: File
section: Objects
order: 2
---

# File (`FileSummary`)

**DTO:** `shared::file::FileSummary`, `ColumnMeta`, `PageQuery`, `Row`
**Table:** `project_files`
**RID prefix:** `FIL`
**Migration:** 001 init; 009 computed stages (dropped `status`)

---

## What a File is

A CSV uploaded into a project. The raw bytes live on disk; the parsed
Polars `DataFrame` lives in an in-memory cache; metadata + column
summaries live in Postgres.

The model is **append-only with a step log**: every cleaning operation
creates a `project_steps` row rather than mutating the file's content.
The "current view" is the base file with applied steps replayed in
order. Undo flips a step's `applied` flag; redo flips it back.

---

## Fields

### `project_files` table

| Field | DB column | Type | Nullable | Default | Description |
|---|---|---|---|---|---|
| `redpash_id` | `redpash_id` | `TEXT` PK | NO | — | `FIL_…` |
| `project_redpash_id` | `project_redpash_id` | `TEXT` FK | NO | — | → `projects.redpash_id` ON DELETE CASCADE |
| `filename` | `filename` | `TEXT` | NO | — | Original filename (incl. `.csv` extension) |
| `display_name` | `display_name` | `TEXT` | YES | — | UI label override. Defaults to `filename`. |
| `file_type` | `file_type` | `TEXT` | NO | `'csv'` | Asset kind. Today only `csv`. Reserved values: `csv_clean`, `png_chart`, `html_report`, `html_dashboard` (Django parity, not yet emitted). |
| `row_count` | `row_count` | `BIGINT` | YES | — | Row count of the **base** frame. Cached at upload time. |
| `col_count` | `col_count` | `INTEGER` | YES | — | Column count of the base frame. |
| `file_size_bytes` | `file_size_bytes` | `BIGINT` | YES | — | Raw bytes on disk. |
| `cleanness_pct` | `cleanness_pct` | `REAL` | YES | — | 0–100 quality score from `data::stats::cleanness` — see [Cleanness score](#cleanness-score) below. Recomputed on upload / join / snapshot / cache-miss hydrate. |
| `encoding` | `encoding` | `TEXT` | YES | — | Detected (chardetng) or user-overridden. |
| `delimiter` | `delimiter` | `TEXT` | YES | `','` | CSV field delimiter. |
| `storage_path` | `storage_path` | `TEXT` | NO | — | Relative path under `REDPASH_DATA_DIR/`. Convention: `files/<rid>.bin`. |
| `columns_meta` | `columns_meta` | `JSONB` | NO | `'[]'::jsonb` | Cached `Vec<ColumnMeta>` so the redtable doesn't re-summarise on every page load. Recomputed after applied steps. |
| `created_at` | `created_at` | `TIMESTAMPTZ` | NO | `now()` | |
| `updated_at` | `updated_at` | `TIMESTAMPTZ` | NO | `now()` | |

### `FileSummary` DTO (over the wire)

```rust
pub struct FileSummary {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub filename:           String,
    pub display_name:       Option<String>,
    pub file_type:          String,
    pub stage:              String,      // computed — see "Pipeline stage" below
    pub row_count:          Option<u64>,
    pub col_count:          Option<u32>,
    pub file_size_bytes:    Option<u64>,
    pub cleanness_pct:      Option<f32>,
    pub encoding:           Option<String>,
    pub delimiter:          Option<String>,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}
```

`storage_path` and `columns_meta` are *not* exposed — they're internal
to the backend.

### Pipeline stage (computed)

`stage` replaced the old stored `status` column in migration 009. It
isn't a column — it's derived on every read from the `file_stages` SQL
view, which classifies a file by the furthest point it's reached in
the **import → clean → report → publish** pipeline:

| `stage` | When |
|---|---|
| `import` | Uploaded — no steps, not used in any report. |
| `clean` | Has ≥1 row in `project_steps` (touched in the cleaner — applied or undone history both count). |
| `report` | The file is `source_file_id` of ≥1 `reports` row. |
| `publish` | A report sourced from this file is referenced by a widget inside a **public** dashboard (`dashboards.is_public`, `spec.widgets[].spec.report_id`). |

Stages are ordered; the highest matching condition wins. A freshly
uploaded / joined / snapshotted file is always `import`. The view also
exposes `stage_rank` (0–3) so the project query can aggregate it —
see [project.md](project.md).

### Cleanness score

`cleanness_pct` (0–100) comes from `data::stats::cleanness(df, columns)`
— a two-tier intrinsic score: `value_quality × structural_integrity`.
Structure (parse-shape, encoding, header) is a **gate**; value quality
is a weighted blend of completeness / type-consistency / value-hygiene /
row-uniqueness. Recomputed on every upload, join, snapshot, and
cache-miss hydrate.

Full design — sub-signals, weights, semantic-dtype sniffing, reference
scores, eval harness — lives in [**features/cleanness.md**](../features/cleanness.md).

### `ColumnMeta`

One per source column. Populated by `data::dtype::summarize(df)` on
upload and on every applied step.

```rust
pub struct ColumnMeta {
    pub name:       String,
    pub dtype:      String,         // int | float | date | bool | string | empty
    pub null_pct:   Option<f32>,
    pub unique_pct: Option<f32>,
    pub sample:     Option<String>, // first non-null value, truncated
}
```

### `PageQuery` (redtable query string)

```rust
pub struct PageQuery {
    pub page:    Option<u32>,
    pub size:    Option<u32>,
    pub sort:    Option<String>,   // legacy single-col
    pub dir:     Option<String>,   // asc | desc
    pub sorts:   Option<String>,   // JSON array of {col, dir} — multi-key
    pub q:       Option<String>,   // search query
    pub filters: Option<String>,   // JSON FilterNode tree
    pub cols:    Option<String>,   // comma-separated visible cols
}
```

`sorts` (multi-key) takes precedence over `sort + dir` (legacy single)
when both are present. The frontend always sends `sorts`.

### `Row`

```rust
pub type Row = Vec<Option<String>>;
```

A page row — one `String` per column, `None` for null cells. The
backend stringifies every cell so the wire format is plain JSON
strings; the frontend handles display formatting.

---

## Storage layout

Raw bytes:
```
<REDPASH_DATA_DIR>/files/<rid>.bin
```

`REDPASH_DATA_DIR` defaults to `./data` (relative to the `cargo run`
working directory). Override via env var.

The file is the **original uploaded CSV** — bytes-for-bytes. Cleaning
steps don't rewrite it. The cleaned view is recomputed on demand by
replaying the applied steps over a fresh parse.

In-memory cache (`AppState.files: DashMap<rid, FileEntry>`):

```rust
pub struct FileEntry {
    pub summary: FileSummary,
    pub columns: Vec<ColumnMeta>,
    pub frame:   Arc<DataFrame>,    // current view (applied steps replayed)
}
```

Survives many requests; lost on restart. Cache miss → re-read disk →
re-parse → replay applied steps → repopulate. The hot path goes
through `routes::files::hydrate(state, rid)`.

---

## Lifecycle

```
1. POST /api/files/upload   (multipart)
   │
   ▼
2. resolve_user_rid(state, headers)         → user RID
   ensure_default_project(state.db, user)   → project RID
   │
   ▼
3. id::new("FIL") → rid
   write bytes to <data_dir>/files/<rid>.bin
   │
   ▼
4. spawn_blocking:
     data::parse::from_csv_bytes(&bytes, tld_hint)
     data::dtype::summarize(&df)
   │
   ▼
5. db::insert_file(rid, project, filename, encoding,
                   row_count, col_count, size, storage_path, &columns)
   │
   ▼
6. Build FileSummary, return FileEnvelope { summary, columns, steps: [] }
```

### Applying a step

```
POST /api/files/:rid/steps   body: { kind, params }
  └─► hydrate(state, rid)                  → FileEntry
      └─► data::steps::apply(frame, kind, params)  → new DataFrame
          └─► db::insert_step (ordinal = max+1, applied = true)
              └─► update cache with new frame
                  └─► db::update_file_meta (row_count, col_count, columns_meta)
                      └─► return StepResult
```

### Undo / redo

`project_steps.applied` is a boolean. Undo flips the last applied
step to `applied = false`; redo flips the first un-applied step to
`true`. Re-applies the step chain on each toggle.

### Hydrate (cache miss)

`routes::files::hydrate(state, rid)`:

1. Cache hit? Return.
2. `db::find_file` → metadata.
3. `db::list_steps(rid)` → step history.
4. Read bytes from disk.
5. `spawn_blocking { from_csv_bytes → steps::replay }` → current frame.
6. `data::dtype::summarize(df)` → column meta.
7. Insert into `state.files` cache.

---

## DB helpers

| Helper | Purpose |
|---|---|
| `db::insert_file(...)` | Initial INSERT at upload time |
| `db::find_file(rid)` | Single-row fetch by RID |
| `db::list_files_in_project(project_rid)` | List files in a project (for `GET /projects/:rid/files`) |
| `db::update_file_meta(rid, display_name, project_redpash_id, encoding, delimiter)` | Sparse PATCH update — rename / move to another project / set encoding / set delimiter. COALESCE per field; re-fetches via `find_file` for the joined stage |
| `db::update_file_columns(rid, columns, row_count, col_count, cleanness)` | After applied steps |
| `db::list_steps(file_rid)` | All steps in `ordinal` order |
| `db::insert_step(file_rid, kind, params)` | Append a step |
| `db::set_applied(step_rid, applied)` | Flip the bit for undo/redo |
| `db::delete_file(rid)` | DELETE row + cascade `project_steps` |

---

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/files/upload` | multipart `file` (+ optional `tld` hint). Lands in session user's default project. 256 MiB body limit. |
| GET | `/api/files/:rid` | `FileEnvelope { summary, columns, steps }` |
| PATCH | `/api/files/:rid` | Sparse metadata edit — `display_name`, `project_redpash_id` (move to another owned project), `encoding`, `delimiter`. See [api/files.md](../api/files.md#patch-apifilesrid). |
| DELETE | `/api/files/:rid` | Remove the file (cascades to `project_steps` + `reports`); unlinks the blob. |
| GET | `/api/files/:rid/page` | Paged rows — see `PageQuery` |
| POST | `/api/files/:rid/steps` | Apply a step — body `{ kind, params }` |
| POST | `/api/files/:rid/undo` · `/redo` | Walk the step cursor |
| POST | `/api/files/:rid/encoding` | Override detected encoding — body `{ encoding }` |
| GET | `/api/files/:rid/dedup` | Duplicate-row counts (full-row + per-PK) |
| GET | `/api/files/:rid/joins` | Detect candidate keys against other files in the project. Query `filters` for filter-aware detection. |
| POST | `/api/files/:rid/joins` | Apply a join — body `{ other_file_id, this_col, other_col, filters? }` — materialises a new joined CSV as a new `FIL_…` |
| POST | `/api/files/:rid/snapshot` | Save the current view as a new file with empty step history |
| GET | `/api/files/:rid/uniques` | Per-column unique-value counts (used by the report builder to sort low-cardinality columns first) |

---

## Step kinds (`StepRequest.kind`)

Dispatched by `data::steps::replay`:

| `kind` | `params` shape | Effect |
|---|---|---|
| `drop_duplicates` | `{}` | Drop full-row duplicates |
| `drop_nulls` | `{ columns?, threshold? }` | Drop rows with too many nulls |
| `fill_nulls` | `{ strategy: "mean"\|"median"\|"zero"\|"mode"\|"Unknown", column?, value? }` | Replace nulls |
| `cast` | `{ column, dtype }` | Coerce column to dtype |
| `rename` | `{ old_name, new_name }` | Rename one column |
| `drop_column` | `{ column }` | Drop a column |
| `snake_case` | `{}` | Snake-case all column names |
| `replace_in_names` | `{ find, replace? }` | Find-replace in column names |
| `change_case` | `{ mode: "lower"\|"upper" }` | Recase all column values (title-case isn't in Polars 0.43; only lower/upper) |
| `filter_columns` | `{ columns }` | Keep only the listed columns |
| `split_column` | `{ column, sep, keep_original }` | Split on separator |
| `join_columns` | `{ col1, col2, sep, new_name }` | Concatenate two columns |
| `remove_text` | `{ column, pattern, is_regex }` | Strip matching text |
| `replace_text` | `{ column, find, replace, is_regex }` | Find-replace within values |
| `fix_invalid` | `{ column, sentinel, replacement? }` | Replace sentinel ("N/A", "—") |
| `format_dates` | `{ column, fmt?, on_incomplete }` | Cast to date with flexible source format |

Adding a new kind: arm in `data::steps::replay`, plus a helper in
`data::*`, plus a frontend tool module under `scripts/cleaner/tools/`
+ sidebar wiring.

---

## Frontend

| Asset | Location |
|---|---|
| **Cleaner partial** | `partials/cleaner.html` |
| **Controller** | `scripts/cleaner/index.js` — owns the uploader, redtable mount, action dispatch |
| **Upload input** | `<input id="cleaner-file" type="file" accept=".csv,text/csv" hidden />` |
| **Tools sidebar** | `scripts/cleaner/tools/sidebar.js` — one module per tool kind |
| **Filter panel** | `scripts/cleaner/filters/panel.js` — also reused by the reports page |
| **Redtable** | `scripts/redtable/*` (component dir) |

---

## Notes

- **Today the file_type is always `csv`.** The reserved values
  (`csv_clean`, `png_chart`, `html_report`, `html_dashboard`) mirror
  the Django app's enum but no path emits them yet. Snapshot
  ("save as cleaned file") creates another `csv` row — not `csv_clean`.
- **Snapshots have no step history.** Creating a snapshot
  materialises the current view (filtered/sorted) as a fresh `FIL_…`
  with `project_steps` empty. The new file is independent — undoing
  the original doesn't affect the snapshot.
- **The on-disk file is immutable.** Cleaning steps never rewrite
  `<rid>.bin`. To export the cleaned view, the frontend currently
  takes a snapshot + downloads from `/api/files/:rid/page` row-by-row;
  a `/api/files/:rid/export` endpoint is on the deferred list.
- **`uploaded_by` is not stored.** The current schema doesn't track
  who uploaded a file (it's implicit via `project_redpash_id →
  projects.owner_id`). Phase 4c may add an explicit column when
  multi-user projects ship.
