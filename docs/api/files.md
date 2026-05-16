---
title: Files
section: API
order: 6
---

# `/api/files/*`

The cleaner page's home base. Upload, read paged rows, apply cleaning
steps, undo / redo, snapshot, detect & apply joins.

**Route file:** [`crates/api/src/routes/files.rs`](../../backend/crates/api/src/routes/files.rs)
**DTOs:** [`shared::file::*`](../objects/file.md)
**Persistence:**
- Bytes → `<REDPASH_DATA_DIR>/files/<rid>.bin` (immutable)
- Metadata → `project_files` row
- History → `project_steps` rows (append-only, `applied` toggled by undo / redo)
- Hot frame → in-memory cache; cache miss replays applied steps on top of the freshly-parsed base

---

## `POST /api/files/upload`

Multipart upload. Detects encoding (chardetng), parses with Polars,
inserts a `project_files` row in the **uploader's default project**
(creating it if needed via `ensure_default_project`).

**Body limit:** 256 MiB (`DefaultBodyLimit` + per-field `MAX_UPLOAD_BYTES` recheck).

### Fields

| Field   | Required | Type      | Notes |
|---------|----------|-----------|-------|
| `file`  | yes      | file part | The CSV bytes. Filename is captured from the multipart header. |
| `tld`   | no       | text      | TLD hint for the encoding detector (`fr`, `ch`, …). Improves Latin-1 vs UTF-8 disambiguation. |

### Response

```jsonc
201 Created
{
  "summary": { /* FileSummary, see objects/file.md */ },
  "columns": [ /* ColumnMeta[] */ ],
  "steps":   []     // a fresh file has no applied steps
}
```

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `missing_file`    | No `file` field in the multipart body |
| 400    | `too_large`       | File > 256 MiB |
| 400    | `multipart`       | Malformed multipart envelope |
| 400    | `invalid_csv`     | Polars couldn't parse the file at the detected encoding |
| 401    | `unauthenticated` | OAuth enabled, no session cookie |
| 500    | `io` / `db`       | Disk write or DB insert failed |

**Multi-file note:** The handler still reads a single `file` field per
request, but the frontend's two upload entry points — the Objects /
Cleaner **+ add file** buttons and the upload modal — now both accept
`multiple` selections and fan them out into N parallel
`POST /api/files/upload` calls, reporting per-file success / failure on
the way back.

---

## `GET /api/files/:rid`

Summary + columns + applied / undone steps. Hydrates the frame from
disk on first call.

```jsonc
200 OK
{
  "summary": { /* FileSummary */ },
  "columns": [ /* ColumnMeta[] */ ],
  "steps":   [ /* ProjectStep[] — both applied and undone, ordered */ ]
}
```

### Errors

| Status | `kind`        | When |
|--------|---------------|------|
| 404    | `not_found`   | RID isn't in `project_files` |
| 400    | `invalid_csv` | Stored bytes no longer parse (e.g. encoding override is wrong) |
| 500    | `io` / `db`   | Disk or DB read failed |

---

## `PATCH /api/files/:rid`

Sparse metadata edit from the Objects overview's inline edit-mode.
Auth: session required + owner-match (`ensure_owner`). All body fields
optional — only the present ones change (`COALESCE`):

```jsonc
PATCH /api/files/FIL_…
{
  "display_name":       "Q4 dossiers.csv",   // inline rename
  "project_redpash_id": "PRJ_…",             // move to another of the owner's projects
  "encoding":           "windows-1252",      // re-decode the stored bytes
  "delimiter":          ";"                  // display metadata only
}
```

- **`project_redpash_id`** — the target must be a project the same
  user owns; resolving the owner doubles as the existence check, so a
  missing / unowned project is a `404`.
- **`encoding`** — validated against `encoding_rs` labels before the
  write (same check as `POST /:rid/encoding`); an unknown label is a
  `400 invalid_encoding`.
- **`delimiter`** — stored metadata; the parser auto-detects on
  re-parse, so this doesn't trigger a re-decode.

An `encoding` or `project_redpash_id` change makes the hot-frame cache
entry stale, so it's evicted — the next access re-hydrates from disk.
The cleaning pipeline (steps, columns) has its own endpoints, and
`stage` is computed (the `file_stages` view), not editable here.

Returns the updated `FileSummary`.

### Errors

| Status | `kind`              | When |
|--------|---------------------|------|
| 400    | `invalid_encoding`  | `encoding` isn't a known `encoding_rs` label |
| 401    | `unauthenticated`   | OAuth enabled, no session |
| 404    | `not_found`         | File RID missing / not owned, or `project_redpash_id` not a project the caller owns |
| 500    | `db`                | Postgres unreachable |

---

## `DELETE /api/files/:rid`

Remove a file. Auth: session required + owner-match. The DB delete
cascades to `project_steps` (history) and `reports` built from this
file; the hot-frame cache entry is evicted first and the on-disk blob
is removed best-effort afterwards.

```
204 No Content
```

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | File RID missing or owned by another user |
| 500    | `db`              | Postgres unreachable |

---

## `GET /api/files/:rid/page`

Paged rows — the redtable's data source. Every toolbar interaction
(sort, filter, search, column visibility, page change) maps to a tweak
on the query string.

### Query parameters (`PageQuery`)

| Param     | Type        | Default | Notes |
|-----------|-------------|---------|-------|
| `page`    | u32         | 1       | 1-indexed |
| `size`    | u32         | 25      | Clamped to `[1, 50000]` |
| `sort`    | string      | —       | Legacy single-column sort (col name) |
| `dir`     | `asc \| desc` | —     | Pair with `sort` |
| `sorts`   | JSON        | —       | Multi-sort: `[{"col":"…","dir":"asc"}, …]`. Takes precedence over `sort`/`dir`. |
| `q`       | string      | —       | Free-text search across all string columns |
| `filters` | JSON        | —       | `FilterNode` — leaf `{col, op, value}` or `{op:"and"\|"or", children:[…]}` |
| `cols`    | csv string  | —       | Visible columns, ordering preserved |

### Response (`Page<Row>`)

```jsonc
200 OK
{
  "rows":        [["…","…",null], …],
  "total":       137,          // matches the filter
  "all_count":   101234,       // total in the underlying frame (pre-filter)
  "page":        1,
  "size":        25,
  "pages":       6,
  "ms":          12,
  "row_indices": [0, 1, 2, …]  // absolute row index per page row
}
```

`row_indices` are the post-step-replay, pre-filter indices — the
frontend uses them to build a precise `drop_rows` step when the user
selects rows under an active filter.

### Errors

| Status | `kind`          | When |
|--------|-----------------|------|
| 400    | `invalid_spec`  | Unknown column in `sort` / `sorts` / `filters` |
| 404    | `not_found`     | File RID missing |
| 500    | `internal`      | Polars panic during query |

---

## `POST /api/files/:rid/steps` — apply a cleaning step

Body: `{ "kind": "…", "params": { … } }` (`StepRequest`).

The handler:
1. Validates the step by applying it to the cached frame **before**
   touching the DB. A poisoned step would otherwise wedge the file.
2. Inserts a `STP_…` row in `project_steps` (`applied = TRUE`).
3. Invalidates the cache so the next hydrate replays from disk
   including the new step.

### Step kinds

| `kind`          | What it does | Cell-diff tracked? |
|-----------------|--------------|--------------------|
| `drop_columns`  | Remove columns by name | — |
| `rename_column` | Rename one column | — |
| `drop_rows`     | Drop rows by absolute index | — |
| `drop_nulls`    | Drop rows with nulls in given columns | — |
| `fill_nulls`    | Fill nulls with a constant or strategy | yes |
| `replace_text`  | Find / replace in string column(s) | yes |
| `change_case`   | upper / lower / title-case | yes |
| `fix_invalid`   | Replace one-or-more sentinel values with a constant or NULL across one column, an explicit list, or every string column. Accepts `sentinels: [string]` + optional `columns: [string]` + optional `replacement`; legacy `{column, sentinel}` shape still honoured for old `project_steps` rows. | yes |
| `cast`          | Cast a column to `int` / `float` / `bool` / `date` / `string` (best-effort, nulls failures) | yes |
| `unwrap_csv`    | Re-parse a CSV whose every cell came in wrapped in quotes (preamble row, escaped commas, etc.) — see below | — |

Cell-diff tracked steps report `cells_changed` in the response so the
frontend can toast "filled 47 nulls" / "replaced 12 cells". Structural
steps and any step that changes row count omit that field.

**`unwrap_csv` defensive unquote.** The step re-emits the frame as CSV
and feeds it through our own `parse_text` (preamble skip + quote-aware
delimiter detection + `truncate_ragged_lines`). Polars' first pass
sometimes leaves *some* values still wrapped in `"…"` while others come
through bare, so before each cell is re-emitted it passes through
`defensive_unquote`: strip a balanced outer `"` pair, then collapse
`""` → `"`. This is the post-Django evolution of the same heuristic —
their version stripped *all* quotes everywhere, which corrupted any
field whose content genuinely contained a quote.

### Response

```jsonc
200 OK
{
  "summary": { /* FileSummary, refreshed counts */ },
  "columns": [ /* ColumnMeta[], refreshed */ ],
  "steps":   [ /* ProjectStep[] including the new one */ ],
  "last_op": {
    "rows_before":   101234,
    "rows_after":    101187,
    "cells_changed": null     // or a u64 when applicable
  }
}
```

### Errors

| Status | `kind`         | When |
|--------|----------------|------|
| 400    | `invalid_spec` | Step `kind` unknown or `params` invalid |
| 404    | `not_found`    | File RID missing |
| 500    | `db` / `io`    | DB insert / cache rebuild failed |

---

## `POST /api/files/:rid/undo` and `/redo`

Toggle the most-recent step's `applied` flag. No-ops when nothing's
applied (undo) or no undone steps (redo). Both return the same
envelope as `GET /api/files/:rid`.

```jsonc
200 OK
{
  "summary": { /* … */ },
  "columns": [ /* … */ ],
  "steps":   [ /* updated history */ ]
}
```

---

## `POST /api/files/:rid/encoding`

Override the detected encoding. Validated through `encoding_rs` before
the DB write, then the cache is invalidated.

```jsonc
POST /api/files/:rid/encoding
{ "encoding": "latin-1" }   // or "utf-8", "windows-1252", "shift_jis", …
```

### Errors

| Status | `kind`             | When |
|--------|--------------------|------|
| 400    | `invalid_encoding` | `encoding_rs::Encoding::for_label` returned `None` |
| 404    | `not_found`        | File RID missing |

---

## `GET /api/files/:rid/dedup`

Duplicate-row counts. Full-row dedup by default; `?by=col1,col2`
narrows to a key.

### Query

| Param   | Type   | Default | Notes |
|---------|--------|---------|-------|
| `by`    | csv    | —       | Empty → full-row dedup |
| `limit` | usize  | 500     | Cap on rows in the preview, clamped `[1, 5000]` |

Response is `data::dedup::DedupReport` — a small JSON with totals plus
a preview of duplicated row groups.

---

## `GET /api/files/:rid/uniques`

Per-column unique value counts. Used by the report builder to pre-sort
low-cardinality columns and by the filter panel's value-autocomplete.

### Query

| Param   | Type   | Default | Notes |
|---------|--------|---------|-------|
| `col`   | string | —       | Required — column name |
| `limit` | usize  | 200     | Clamped `[1, 1000]` |

```jsonc
200 OK
{ "values": ["…", "…", …] }
```

---

## `GET /api/files/:rid/joins`

Detect candidate join keys against every other file in the same
project. The detector uses an **overlap coefficient** scored over
sample value sets — see [features/joins.md](../features/joins.md).

### Query

| Param       | Type  | Default | Notes |
|-------------|-------|---------|-------|
| `threshold` | f32   | 0.3     | Min overlap to surface a candidate, clamped `[0, 1]` |
| `per_file`  | usize | 20      | Max candidates per other-file, clamped `[1, 200]` |
| `filters`   | JSON  | —       | Same shape as `PageQuery.filters`. When present, the current file is filtered first — candidates match what the user sees. |

```jsonc
200 OK
{
  "files": [
    {
      "redpash_id": "FIL_…",
      "title":      "temps_log.csv",
      "candidates": [
        {
          "this_col":   "dossier_id",
          "other_col":  "case_ref",
          "overlap":    0.97,
          /* …more candidate fields… */
        }
      ]
    }
  ]
}
```

---

## `POST /api/files/:rid/joins`

Materialise a join as a new CSV file in the same project. Streams
straight to disk so big joins don't OOM the process.

### Body (`CreateJoinBody`)

```jsonc
{
  "other_file":  "FIL_…",
  "this_cols":   ["dossier_id"],   // compound keys: pair by position
  "other_cols":  ["case_ref"],
  "join_type":   "inner",          // inner | left | outer
  "name":        "case_with_time.csv",   // optional, defaults to "<this>__<other>_join.csv"
  "filters":     { /* FilterNode */ }    // optional — when present, only matching rows participate
}
```

### Response

```jsonc
201 Created
{
  "summary": { /* FileSummary for the new joined file */ },
  "columns": [ /* ColumnMeta[] */ ],
  "steps":   []
}
```

### Errors

| Status | `kind`         | When |
|--------|----------------|------|
| 400    | `invalid_spec` | `this_cols` / `other_cols` empty or length mismatch |
| 404    | `not_found`    | Either file RID missing |
| 500    | `io` / `db`    | Disk write or DB insert failed |

---

## `POST /api/files/:rid/snapshot`

Materialise the current view (post step-replay) as a fresh
project_files row with no step history. Used to hand a clean snapshot
to Reports / Dashboards so step changes don't invalidate them.

```jsonc
POST /api/files/:rid/snapshot
{ "name": "dossiers_cleaned.csv" }   // optional; defaults to "<source>_cleaned.csv"
```

```jsonc
201 Created
{
  "summary": { /* FileSummary for the snapshot */ },
  "columns": [ /* … */ ],
  "steps":   []
}
```

---

## `GET /api/files/:rid/sentinels`

Scan every string column for cells whose trimmed-lowercased form
matches one of `data::stats::SENTINELS` (`n/a`, `na`, `-`, `?`,
`null`, `nan`, `#n/a`, `tbd`, `unknown`, …) **or one of the caller's
`extra=`** values. Drives the Cleaner's *Fix invalid values* modal —
the picker shows the user **what's actually in their file** instead
of letting them guess, and the `extra` channel lets the modal extend
the scan with the user's `prefs.learned_sentinels` set + any value
they just typed into the modal.

### Query

| Param   | Type | Default | Notes |
|---------|------|---------|-------|
| `extra` | csv  | —       | Extra values to also match. Frontend joins `prefs.learned_sentinels` + this-session ad-hoc additions and URL-encodes. Whitespace + empties dropped server-side; case folded to lowercase for matching. Realistic sentinels are short alphanum / punctuation, so a literal `,` inside one is improbable; if needed, switch to JSON later. |

```jsonc
200 OK
{
  "items": [
    {
      "value":     "NA",                 // cell value as-found (original casing)
      "canonical": "na",                 // lowercased-trimmed bucket key
      "total":     2943,                 // total cells in the file
      "columns":   [
        ["cause_intervention", 1000],
        ["type_d_energie",      994],
        ["formule",             949]
      ]                                  // sorted by count desc, then name asc
    }
  ],
  "known": ["n/a", "na", "n.a.", "-", "--", "?", "null", "none",
            "nan", "#n/a", ".", "tbd", "x", "#ref!", "#value!",
            "unknown", "undefined"]
}
```

`items` is **sorted by `total` desc** (most-frequent first), then by
`value` asc for stability. Variants of the same canonical sentinel
are reported separately (`"N/A"` and `"n/a"` get their own rows) so
the UI can preserve the user's casing on replace. `known` is the
canonical list — useful for empty-result copy ("0 found across N
known sentinels").

This endpoint is read-only; the replace happens through
`POST /api/files/:rid/steps` with `kind: "fix_invalid"`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | File RID missing |

---

## `POST /api/files/:rid/cast-preview`

**Dry-run** for the `cast` step. The user hit a silent-null incident
(casting a date column with a stray `"2023"` value silently nulled
that cell; they only noticed by luck), so cast is now a two-phase
flow:

1. Frontend POSTs the proposed `(column, target_type)`.
2. Backend clones the cached frame, applies `data::steps::apply(frame,
   "cast", { column, target })`, and counts cells where the *before*
   was non-null but the *after* is null — those are the values the
   cast would silently drop. It also returns up to N sample values to
   show in the modal.
3. Frontend renders a styled modal (no native `confirm()` — too easy
   to dismiss without reading the count) with the would-null count +
   samples. The user confirms → real `POST /api/files/:rid/steps`
   with the same params. Dismiss → no-op.

```jsonc
POST /api/files/FIL_…/cast-preview
{ "column": "signed_at", "target": "date" }
```

```jsonc
200 OK
{
  "would_null": 3,
  "samples": ["2023", "n/a", "?"]
}
```

This endpoint does **not** mutate state — the cache, the DB, and the
disk blob are all untouched. The cast itself still goes through
`POST /api/files/:rid/steps`.

| Status | `kind`         | When |
|--------|----------------|------|
| 400    | `invalid_spec` | Unknown column / unknown target type |
| 404    | `not_found`    | File RID missing |

---

## `POST /api/files/:rid/cleanness` and `DELETE`

Compute or clear the file's overall `cleanness_pct` score (the
percentage that lights up the Files-tab cleanness column and the
Cleaner header bar).

- **`POST`** — runs the cleanness scoring pipeline (see
  [features/cleanness.md](../features/cleanness.md)) on the current
  frame and writes the result back to `project_files.cleanness_pct`.
  Idempotent — re-running just recomputes against the current frame.
- **`DELETE`** — nulls out `cleanness_pct` so the file shows as
  "unscored" again. Used by the Objects-page **Clear scores** toolbar
  + bulk action to drop stale scores in bulk before a fresh run.

Both return the updated `FileSummary`.

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | File RID missing |
| 500    | `db`              | Postgres unreachable |

---

## Related

- [objects/file.md](../objects/file.md) — DTOs, `project_files` schema, step kinds detail.
- [features/cleaner.md](../features/cleaner.md) — the UI on top of these endpoints.
- [features/cleanness.md](../features/cleanness.md) — cleanness scoring + dtype sniffer.
- [features/joins.md](../features/joins.md) — overlap-coefficient algorithm.
