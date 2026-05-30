---
title: Chart — object metadata
section: Internal
order: 52
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Chart (CHT_)

A saved visualisation — one `project_files` row with `file_type =
'chart'`. The `spec` JSONB column carries the whole chart definition:
kind + group-by/agg + the baked-in ECharts `option` + an SVG snapshot
+ per-kind modifiers. Backend stores and serves the spec without
ever reading into it — chart-rendering lives entirely in the FE
chart engine (`scripts/charts/`).

Chart is a **derived view** of [file](file.md): the canonical row
schema lives in `project_files`, this doc covers the chart-kind-
specific contract (spec shape, source_file_id semantics, the
dedicated CRUD endpoints).

**Backing table:** `project_files` (migration `20260512000001_init.sql`
base + `20260530000001_chart_files.sql` added the `spec` JSONB column
+ the `source_file_id` self-FK). Discriminator: `file_type = 'chart'`.
**DTO:** `backend/crates/shared/src/chart.rs` (`Chart` + `ChartRequest`).
**Routes:** `backend/crates/api/src/routes/charts.rs` (the full CRUD —
list / create / read / update / delete). `backend/crates/api/src/routes/admin.rs`
carries the paginated admin list (`/admin/charts`) for the Home Charts
tab. Chart rows also surface through generic file machinery
(`db::insert_file` / `find_file` / `delete_file`) but the chart-typed
read path comes back through `/api/charts/:rid` so callers get the
Chart DTO instead of the bare FileSummary.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/charts` | Body: `ChartRequest { source_file_id, title, spec }`. Server assigns `CHT_<32hex>`, persists as a `file_type='chart'` row in `project_files`. The `project_redpash_id` is resolved from the source file's project (charts live in the same project as the data file they source). Source-file existence + caller-ownership both validated. Emits `chart_create`. |
| `read` | `GET /api/charts/:rid` | Returns the full `Chart` DTO (owner-gated). |
| `update` | `PUT /api/charts/:rid` | Body: `ChartRequest { source_file_id, title, spec }`. Full replace (NOT sparse — clients send the whole spec on every save). Emits `chart_update`. |
| `delete` | `DELETE /api/charts/:rid` | Hard delete. Cascades widget references via the dashboard-spec soft refs (no FK; dashboards continue to render an error tile for missing chart_ids). Emits `chart_delete`. |
| `list` | `GET /api/charts` | Returns `{ items: Vec<Chart> }` — session user's chart-typed files across every project. Unpaginated today; ordered by created_at ASC. |
| `list (admin)` | `GET /api/admin/charts?page&size&sort&dir&q` | Paginated `Page<ChartSummary>` for the Home Charts tab. JOINs project_files + projects (project name). |
| `search` | `GET /api/admin/charts?q=…` | ILIKE substring on `display_name` + `filename` (only on the admin endpoint). |
| **PATCH (sparse meta)** | — | **Not supported.** Unlike Dashboard which exposes PATCH /api/dashboards/:rid for sparse title / description / folder / is_favorite / is_public, Chart only has full-replace PUT. If a client wants to only change the title, they re-send the whole `ChartRequest`. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format CHT_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("CHT").
               Note: charts use CHT_ prefix while sharing the
               project_files table — workspace.js routes by rid
               prefix to disambiguate without a probe call.
```

```
project_redpash_id
  Type:        TEXT NOT NULL / String — FK to projects.redpash_id
  Properties:  Layout
  Description: Owning project. NOT a Create-property — server
               resolves from the source file's project (charts
               live in the same project as their source). NOT an
               Update-property — chart moves are deferred (would
               require source-file-move in parallel for the
               source_file_id FK to stay valid).
```

```
source_file_id
  Type:        TEXT NOT NULL / String — FK to project_files.redpash_id (csv-typed)
  Properties:  Create, Update, Layout
  Description: The csv-typed File this chart renders against.
               ON DELETE CASCADE: deleting the source CSV
               cascades the chart row (the chart is meaningless
               without its data). Update is allowed (the same
               ChartRequest re-asserts the source on every PUT) —
               re-pointing a chart at a different data file
               while keeping the chart UI is a legitimate flow.
```

```
title
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update, Sort, Search, Layout
  Description: Display name for the chart. Client-set; required.
               Inline-editable in the chart designer's title bar.
               Stored on the `project_files.display_name` column
               (charts share the canonical row schema).
```

```
spec
  Type:        JSONB NOT NULL / serde_json::Value
  Properties:  Create, Update
  Description: The chart definition — opaque to the backend.
               Canonical shape (from frontend/scripts/charts/build.js):
                 { kind: "bar" | "line" | "pie" | "area" | "funnel"
                       | "gauge" | "pictorial_bar" | "scatter"
                       | "heatmap" | "radar" | "boxplot" | "calendar"
                       | "matrix",
                   group_by: <col-name>,
                   agg_col:  <col-name | "*">,
                   agg_fn:   "count" | "sum" | "mean" | "min" | "max"
                           | "q1" | "median" | "q3" | "stddev",
                   modifiers: { smooth?, regression?, ... },
                   option:   <ECharts spec — full baked-in render-ready>,
                   svg:      <SVG snapshot for the no-JS preview> }
               The backend never reads the keys; the FE chart
               engine drives all rendering. Updates replace the
               whole blob.
```

```
created_at, updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT / bumped on every UPDATE.
               Default sort key on the admin list (created_at DESC).
```

### Hydrated read-only fields

These appear on the admin-list `ChartSummary` (admin endpoint
JOIN) but aren't columns on `project_files`.

```
project_name (admin list only)
  Type:        TEXT / String
  Properties:  Sort, Layout
  Description: projects.name JOINed on project_redpash_id.
               Surfaced on the ChartSummary admin shape; the
               bare Chart DTO carries the FK only.
```

```
stage
  Type:        TEXT / String — enum (see "Enum constraints" on [file](file.md))
  Properties:  Sort, Layout
  Description: **Computed**, folded in from the `file_stages`
               view. For a chart row, `stage` reflects the chart's
               own state (not its source file's): typically
               `design` once the chart exists; `publish` when it
               appears in a public dashboard's widgets.
```

---

## Enum constraints

`kind` (on the spec — not a column): see the canonical shape under
Fields above. 7 rendered chart families today (more kinds are defined in the DTO but not rendered). No DB CHECK; the FE chart engine
rejects unknown kinds with an inline error tile.

`agg_fn` (on the spec — not a column): one of `count / sum / mean /
min / max / q1 / median / q3 / stddev`. Same — opaque to the
backend.

`file_type ∈ { chart }` for this object (per the canonical row's
discriminator in [file](file.md#enum-constraints)). The chart-typed
create endpoint is the only path that writes this value.

---

## Relationships

```
project_redpash_id → Project (PRJ_)
  Cardinality:  N:1 (a Project has many Charts)
  On delete:    CASCADE (project delete drops every file in it,
                charts included)
  Hydrated as:  project_name (admin list only)
```

```
source_file_id → File (FIL_, csv-typed)
  Cardinality:  N:1 (one csv → many charts)
  On delete:    CASCADE (deleting the source CSV cascades the
                chart row — chart is meaningless without its data)
  Hydrated as:  — (chart spec embeds column references; not
                back-joined as a hydrated field)
```

### Inverse relationships

```
Chart is referenced by Dashboard widgets
  Backing:       project_files.spec.widgets[].spec.chart_id (JSONB)
  Cardinality:   N:N (no FK; soft reference)
  On delete:     No CASCADE — deleting a chart leaves dangling
                 widget references. Designer load() renders an
                 error tile for missing chart_ids.
                 See [dashboard](dashboard.md).
```

```
Chart is consumed by file_stages.publish
  Backing:       file_stages view CASE clause checks for a
                 dashboard widget pointing at this chart that
                 sits in a public dashboard
  Cardinality:   N:N (a chart can appear in many dashboards)
  On delete:     No FK (soft); the publish rollup recalculates
                 at SELECT time so a deleted chart simply
                 disappears from the publish set on the next
                 read.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `chart_create` | `POST /api/charts` | `{ chart, source_file, title }` |
| `chart_update` | `PUT /api/charts/:rid` | `{ chart, title }` |
| `chart_delete` | `DELETE /api/charts/:rid` | `{ chart }` |

No per-field events (`chart_title_change` etc.) — the spec is
opaque to the backend, so the canonical "what changed" is the
full PUT body; the activity feed shows "<user> updated chart" and
the reader can diff the spec themselves if they care.
