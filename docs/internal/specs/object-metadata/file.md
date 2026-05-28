---
title: File — object metadata
section: Internal
order: 45
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# File (FIL_)

The canonical content-bearing row. Every file lives in a project; the
`file_type` discriminator names which kind of content it carries:

| `file_type` | RID prefix | Purpose | Per-kind doc |
|---|---|---|---|
| `csv` | `FIL_` | Uploaded data (Excel auto-converted on upload). The `storage_path` points at `<REDPASH_DATA_DIR>/files/<rid>.bin`. | this doc |
| `chart` | `CHT_` | Saved chart spec (no bytes on disk; spec JSONB carries the ChartSpec). | [chart](chart.md) |
| `dashboard` | `DSH_` | Saved dashboard spec (no bytes on disk; spec JSONB carries widgets[]). | [dashboard](dashboard.md) |

The object-model lock (2026-05-22) folded these three kinds into a
single `project_files` row — Report is a derived view, not a kind
([report](report.md)). This doc covers **csv-typed** fields + the
columns every kind carries; chart / dashboard / report docs cover
their kind-specific spec contracts.

**Backing table:** `project_files` (migration `20260512000001_init.sql`
+ follow-ups `20260525000001_filename_stem.sql` (stripped upload
  extensions from filename — file_type owns the extension half)
+ `20260530000001_chart_files.sql` (added `spec` JSONB +
  `source_file_id` self-FK for chart rows)
+ `20260602000001_fold_dashboards.sql` (added `is_public` for the
  publish-overlay; dashboards became `file_type='dashboard'`
  rows)).
**DTO:** `backend/crates/shared/src/file.rs` (`FileSummary` +
`ColumnMeta` + `PageQuery` + `Row`).
**Routes:** `backend/crates/api/src/routes/files/` (decomposed
2026-05-27: `mod.rs` upload + page + steps + undo/redo,
`joins.rs` join detect + apply, `stats.rs` dedup + uniques +
sentinels + cleanness, `output.rs` snapshot + export, `meta.rs`
PATCH + DELETE + display-name + move + encoding, `state_ops.rs`
cast-preview + clear-filters + cleaner cursor ops).
`backend/crates/api/src/routes/admin.rs` carries the paginated
list for the Home Files tab.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/files/upload` | **Multipart**, not JSON. Fields: `file` (required), `project_name` (optional — find-or-create the named project in the caller's workspace; defaults to the caller's default project), `tld` (optional encoding hint). Excel extensions (`.xlsx` / `.xls` / `.xlsm` / `.xlsb` / `.ods`) auto-convert to CSV via calamine. Server assigns `FIL_<32hex>`, persists bytes to `<REDPASH_DATA_DIR>/files/<rid>.bin`, returns the full `FileEnvelope` (summary + columns + steps + empty steps[]). |
| `create (chart)` | `POST /api/charts` | See [chart](chart.md). Different endpoint, same table. |
| `create (dashboard)` | `POST /api/dashboards` | See [dashboard](dashboard.md). |
| `read (summary)` | `GET /api/files/:rid` | Returns the `FileEnvelope` — owner-gated. Hot-frame cache populated on first hit (paginated reads consume the same cached `Arc<DataFrame>`). |
| `read (rows)` | `GET /api/files/:rid/page?page&size&sorts&filters&q&cols` | Paginated row read. `size` clamps to `[1, 50_000]`. `sorts` is JSON-encoded multi-key `[{col, dir}]`; legacy `sort=&dir=` still accepted. `q=` is row-level full-text ILIKE; `filters` is a JSON FilterSpec; `cols` is comma-separated visible column names. |
| `update` | `PATCH /api/files/:rid` | Sparse — `display_name` / `project_redpash_id` (move to another of caller's projects) / `encoding` / `delimiter`. Encoding validated against `encoding_rs`; move target gated on caller's project ownership. Encoding / project change evicts the hot-frame cache. |
| `delete` | `DELETE /api/files/:rid` | Hard delete. CASCADEs steps + chart rows that source_file_id this file. On-disk `.bin` blob unlinked + hot-frame cache evicted. |
| `list (per-project)` | `GET /api/projects/:rid/files` | Returns `{ items: Vec<FileSummary> }` for files in this project — owner-gated. No pagination today; ordered by created_at ASC. |
| `list (per-user)` | `GET /api/files` | Returns `{ items: Vec<FileSummary> }` for every file the session user owns (across all their projects). Powers the Home "My files" surface. |
| `list (admin)` | `GET /api/admin/files?page&size&sort&dir&q` | Paginated `Page<AdminFileSummary>` for the Home Files tab. JOINs project_files + projects (project name) + file_stages (computed stage). |
| `search` | `GET /api/admin/files?q=…` | ILIKE substring on `filename` + `display_name` (only on the admin endpoint). Row-level full-text on csv content uses the `/page?q=` parameter, a different path entirely. |
| `apply step` | `POST /api/files/:rid/steps` | Append a cleaning step + rebuild the cached frame. Returns the updated FileEnvelope. |
| `undo / redo` | `POST /api/files/:rid/{undo,redo}` | Walk the step cursor; returns the rebuilt FileEnvelope. |
| `snapshot` | `POST /api/files/:rid/snapshot` | Save current view as a new file (no step history copied) — emits `file_snapshot`. |
| `export` | `GET /api/files/:rid/export` | Stream current view as a downloadable CSV. No DB write; `Content-Disposition` owns the filename. |
| `joins` | `GET·POST /api/files/:rid/joins` | Detect candidate keys (filter-aware) / apply a join (streams the result to a new file on disk). |
| `dedup / uniques / sentinels / cleanness` | per-resource GETs + POSTs | Per `routes/files/stats.rs`. Read-only stats + the cleanness-score (re)compute. |
| `cast-preview / clear-filters` | per-resource POSTs | Per `routes/files/state_ops.rs`. Dry-run a `cast` step / surgically un-apply every `filter_rows` step (eraser button). |
| `encoding` | `POST /api/files/:rid/encoding` | Override the detected encoding + re-hydrate. Emits `file_re_encode`. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format <PFX>_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. PFX is `FIL` (csv), `CHT` (chart), or
               `DSH` (dashboard). Server-assigned via
               id::new(<PFX>). Hidden by default in the Home
               Files tab.
```

```
project_redpash_id
  Type:        TEXT NOT NULL / String — FK to projects.redpash_id
  Properties:  Update, Layout
  Description: Owning project. Update path: PATCH the field to
               move the file to another project the caller owns
               (target gated on caller's ownership; mismatch →
               404). NOT a Create-property — the upload handler
               resolves the project from the `project_name`
               multipart field (find-or-create) or falls back to
               the caller's default project.
```

```
filename
  Type:        TEXT NOT NULL / String
  Properties:  Sort, Search, Layout
  Description: Filename stem — extension stripped at upload by
               `data::parse::strip_upload_ext` (mig 011).
               `file_type` carries the extension half (csv /
               chart / dashboard). NOT a Create-property (upload
               handler derives from the multipart `file` field's
               filename); NOT an Update-property (rename uses
               `display_name` to preserve the original).
```

```
display_name
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable, Sort, Search, Layout
  Description: User-set rename, overrides `filename` for display.
               NULL initially; inline-editable in the rail (pencil
               on .rt-tab) and the Home Files tab. Sort uses
               `COALESCE(display_name, filename)` so renamed +
               un-renamed files sort coherently.
```

```
file_type
  Type:        TEXT NOT NULL DEFAULT 'csv' / String
  Properties:  Sort, Layout
  Description: Kind discriminator. NOT a Create-property (set
               server-side per endpoint: upload → 'csv',
               /api/charts → 'chart', /api/dashboards →
               'dashboard'). NOT an Update-property (file kind
               doesn't change post-creation). See the kind table
               at the top of this doc.
```

```
storage_path
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: `files/<rid>.bin` for csv rows; empty string for
               chart + dashboard rows (their spec lives in the
               `spec` JSONB column, not on disk). Server-only;
               not surfaced on the FileSummary DTO.
```

```
status
  Type:        TEXT NOT NULL DEFAULT 'ready' / String
  Properties:  Nillable
  Description: Internal upload state flag — `ready` once the
               upload pipeline (sniff + parse + persist) finishes.
               Older `pending` / `error` values are historical;
               every row in steady state is `ready`. Not exposed
               on the wire; consumed by the upload pipeline
               internally.
```

```
row_count
  Type:        BIGINT / Option<u64>
  Properties:  Nillable, Sort, Layout
  Description: Row count from the parsed frame. NULL for chart /
               dashboard rows. Hidden by default in the Home
               Files tab (`defaultHidden: true` on the "Rows"
               column? Actually visible — see LIST_VIEWS).
```

```
col_count
  Type:        INTEGER / Option<u32>
  Properties:  Nillable, Sort, Layout
  Description: Column count from the parsed frame. NULL for chart /
               dashboard rows. Hidden by default in the Home Files
               tab.
```

```
file_size_bytes
  Type:        BIGINT / Option<u64>
  Properties:  Nillable, Sort, Layout
  Description: On-disk size of the `.bin` blob for csv rows; NULL
               for chart / dashboard rows. Hidden by default in
               the Home Files tab.
```

```
encoding
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable
  Description: Character encoding label (BCP-47 / IANA: 'utf-8',
               'windows-1252', etc.). Detected by `chardetng` at
               upload; override via PATCH or /encoding. Validated
               server-side against `encoding_rs::Encoding::for_label`.
```

```
delimiter
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable
  Description: CSV delimiter. Sniffed at upload; PATCH-overridable.
               Common values: ',' / ';' / '\t' / '|'.
```

```
spec
  Type:        JSONB / Option<serde_json::Value>
  Properties:  Nillable
  Description: Kind-specific payload. csv rows: empty / null.
               chart rows: ChartSpec ({option, svg}) — see
               [chart](chart.md). dashboard rows: DashboardSpec
               ({template_id, widgets[]}) — see [dashboard](dashboard.md).
               Update paths go through the per-kind endpoints
               (PUT /api/charts/:rid, PATCH /api/dashboards/:rid),
               not through PATCH /api/files/:rid.
```

```
source_file_id
  Type:        TEXT / Option<String> — self-FK to project_files.redpash_id
  Properties:  Nillable
  Description: chart rows only — points at the csv-typed File the
               chart renders against. ON DELETE CASCADE: deleting
               the source CSV cascades the chart row. csv +
               dashboard rows: NULL.
```

```
is_public
  Type:        BOOLEAN NOT NULL DEFAULT FALSE / bool
  Properties:  Layout
  Description: Publish flag. Added mig 019 for the dashboard-
               publish overlay; chart / csv rows leave it FALSE.
               When true on a dashboard row, every csv that
               sources a chart in that dashboard's widgets
               rolls up to stage `publish`. Layout: NOT surfaced
               on the Home Files tab today; consumed server-side
               by the file_stages view.
```

```
fully_null_rows
  Type:        — (computed at hydrate) / Option<u64>
  Properties:  Nillable
  Description: Rows where every column is null. Computed at
               hydrate / upload / snapshot / join time (NOT on
               the project_files row). Surfaced on the FileEnvelope
               so cleanness UI can show "X fully-empty rows"
               without a second scan.
```

```
cleanness_pct
  Type:        REAL / Option<f32>
  Properties:  Nillable, Sort, Layout
  Description: Cleanness score, computed by `data::stats::score`
               against the user's `learned_sentinels` + the global
               vocabulary. NULL until first compute. Hidden by
               default in the Home Files tab.
```

```
columns_meta
  Type:        JSONB / Vec<ColumnMeta>
  Properties:  — (computed at hydrate, not directly editable)
  Description: Per-column metadata (`{name, dtype, semantic_dtype,
               null_pct, unique_pct, sample}`) folded into the
               FileEnvelope. The dtype/semantic_dtype split:
               `dtype` is what Polars parsed (storage), `semantic_dtype`
               is what it's trying to be (intended). Cleanness
               scorer compares the two — a string-stored,
               float-intended column gets docked for unparseable
               cells.
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT. Default sort key on the admin
               list endpoint. Hidden by default in the Home Files
               tab.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-bumped on every UPDATE (step apply / undo /
               redo / metadata patch / encoding override). Surfaced
               as the "Updated" column on the Home Files tab.
```

### Hydrated read-only fields

These appear on the FileEnvelope (the `GET /api/files/:rid` response)
and on the admin-list `AdminFileSummary` but aren't columns on
`project_files`.

```
stage
  Type:        TEXT / String — enum (see "Enum constraints")
  Properties:  Sort, Layout
  Description: **Computed**, not stored. Folded in from the
               `file_stages` view (mig 023): new / clean / design
               / publish per the rules in the view definition.
               Sort uses the COALESCE alias on the admin endpoint.
```

```
project_name (admin list only)
  Type:        TEXT / String
  Properties:  Layout
  Description: projects.name JOINed on project_redpash_id. Present
               only on AdminFileSummary (the Home Files tab "Project"
               column); the bare FileSummary surfaces the FK as
               `project_redpash_id` only.
```

---

## Enum constraints

`file_type ∈ { csv, chart, dashboard }` — **no DB-side CHECK**
today (free-text TEXT NOT NULL DEFAULT 'csv'). The application
enforces via the per-kind create endpoints (upload writes 'csv',
/api/charts writes 'chart', /api/dashboards writes 'dashboard');
clients have no path to write a fourth value. RBAC will codify the
allow-list when permissions ship.

`status ∈ { ready }` — informal; only `ready` is in steady-state
use today. Pending / error states existed in an early prototype but
were dropped before the upload pipeline became atomic. No CHECK
constraint; the column is effectively a historical artifact.

`stage ∈ { new, clean, design, publish }` — **computed**, see
[project](project.md) for the same enum + the file_stages view's
classification rules (the project stage is the MAX of its files'
stage_rank).

---

## Relationships

```
project_redpash_id → Project (PRJ_)
  Cardinality:  N:1 (a Project has many Files)
  On delete:    CASCADE (deleting a project drops every file in it)
  Hydrated as:  project_name (admin list only)
```

```
source_file_id → File (FIL_, csv-typed)
  Cardinality:  N:1 (chart rows only — many charts can source one CSV)
  On delete:    CASCADE (deleting the source CSV cascades the chart row)
  Hydrated as:  — (chart spec is the consumer; not back-joined)
```

### Inverse relationships

```
File has many Steps
  Backing:       project_steps (FK file_redpash_id)
  Cardinality:   1:N
  On delete:     CASCADE (deleting a file drops its step history)
  Surfaced as:   FileEnvelope.steps[] on GET /api/files/:rid.
                 See [step](step.md).
```

```
File has many Charts (csv-typed → chart-typed inverse via source_file_id)
  Cardinality:   1:N (one csv → many charts)
  On delete:     CASCADE
  Surfaced as:   — (no /api/files/:rid/charts endpoint; charts list
                 globally via /api/charts).
```

```
File is referenced by Dashboard widgets
  Backing:       project_files.spec.widgets[].spec.chart_id (JSONB)
  Cardinality:   N:N (no FK; soft reference)
  On delete:     No CASCADE — deleting a chart leaves dangling
                 widget references. Designer load() renders an
                 error tile for missing chart_ids.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `file_upload` | `POST /api/files/upload` | `{ file, project, filename, file_type, rows? }` |
| `file_patch` | `PATCH /api/files/:rid` | `{ file, fields: [<names>] }` |
| `file_delete` | `DELETE /api/files/:rid` | `{ file }` |
| `file_re_encode` | `POST /api/files/:rid/encoding` | `{ file, encoding }` |
| `file_snapshot` | `POST /api/files/:rid/snapshot` | `{ file, new_file, rows }` |
| `step_apply` | `POST /api/files/:rid/steps` | `{ file, kind, step }` |

`step_apply` is technically a Step event (not a File event) but the
context targets a `file` rid for activity-feed scoping. See
[step](step.md). Join detect / apply / dedup / uniques are
read-only and emit no events. Cleanness recompute is internal —
the score lands on the row, no audit emit today (TODO if the
recompute becomes user-triggered rather than passive).
