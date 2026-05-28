---
title: Dashboard — object metadata
section: Internal
order: 53
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Dashboard (DSH_)

A saved widget composition — one `project_files` row with `file_type
= 'dashboard'`. The `spec` JSONB column carries the
`DashboardSpec { template_id, widgets[] }` shape; widgets reference
charts by id (no embedded chart data, so chart edits propagate). The
2026-05-28 designer-unification work routes both chart files AND
dashboard files through the dashboard canvas, so a chart open is
visually identical to a single-widget dashboard ([file](file.md#supported-calls)
documents the synthetic-wrapper bridge).

Dashboard is a **derived view** of [file](file.md): the canonical row
schema lives in `project_files`, this doc covers the dashboard-kind-
specific contract (spec shape, widget kinds, sparse-PATCH meta
fields, the publish overlay).

**Backing table:** `project_files` (migration `20260512000001_init.sql`
base + `20260602000001_fold_dashboards.sql` folded the prior
`dashboards` table into `project_files` as `file_type='dashboard'`
rows + added `is_public` for the publish overlay). DSH_ rids were
preserved through the migration.
**DTO:** `backend/crates/shared/src/dashboard.rs` (`Dashboard` +
`DashboardSpec` + `Widget` + `DashboardRequest`).
**Routes:** `backend/crates/api/src/routes/dashboards.rs` (CRUD +
sparse PATCH meta + favorite toggle).
`backend/crates/api/src/routes/admin.rs` — `/admin/dashboards` was
**not yet wired** at the time of this draft; dashboards surface
through the same paginated list as files (`/admin/files` filtered to
`file_type='dashboard'`) in the absence of a dedicated endpoint.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/dashboards` | Body: `DashboardRequest { project_redpash_id, title, spec, description?, folder? }`. Server assigns `DSH_<32hex>`, persists as a `file_type='dashboard'` row. Project ownership validated. Returns the new Dashboard. Emits `dashboard_create`. |
| `read` | `GET /api/dashboards/:rid` | Returns the full `Dashboard` DTO (owner-gated). Empty `widgets[]` is valid (the empty-dashboard state). |
| `update (full)` | `PUT /api/dashboards/:rid` | Body: `DashboardRequest` — full replace. The designer's chart-widget appends + reorders all go through this path (the designer rebuilds the whole spec + PUTs). Emits `dashboard_update`. |
| `update (sparse meta)` | `PATCH /api/dashboards/:rid` | Body: `PatchDashboardBody { title? / description? / folder? / is_favorite? / is_public? }`. For inline-edit cells on the Dashboards tab — every field optional, COALESCE-keeps unsent fields. Emits `dashboard_patch`. |
| `delete` | `DELETE /api/dashboards/:rid` | Hard delete. Cascades via the canonical project_files chain. Emits `dashboard_delete`. |
| `favorite` | `POST /api/dashboards/:rid/favorite` | Body: `{ value: bool }`. Convenience over PATCH `is_favorite` — same final state, dedicated endpoint matches the Reports / star-affordance pattern. |
| `list` | `GET /api/dashboards` | Returns `{ items: Vec<Dashboard> }` — session user's dashboards across every project. Unpaginated; ordered by created_at ASC. |
| `list (admin)` | `GET /api/admin/files?file_type=dashboard` (today) | No dedicated `/admin/dashboards` endpoint at the time of this draft. The admin path uses the canonical file admin list with a `file_type=dashboard` filter; queue a dedicated endpoint when the dashboards-tab volume justifies its own pagination shape. |
| `search` | `GET /api/admin/files?q=…&file_type=dashboard` | Same — uses the file admin list's ILIKE columns. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format DSH_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("DSH").
               Preserved through mig 019 — pre-fold-dashboards
               rows kept their original DSH_ rids.
```

```
project_redpash_id
  Type:        TEXT NOT NULL / String — FK to projects.redpash_id
  Properties:  Create, Layout
  Description: Owning project. Client-set on Create (the
               DashboardRequest carries it explicitly, unlike Chart
               where the server resolves from the source file).
               Validated against caller's ownership. NOT an
               Update-property — dashboard moves are deferred.
```

```
title
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update, Sort, Search, Layout
  Description: Display name. Required on Create. Inline-editable
               via the sparse PATCH path (PATCH /api/dashboards/:rid
               with `{ title }`).
```

```
description
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable, Search, Layout
  Description: Optional long-form description. Hidden by default
               in the Home Dashboards tab.
```

```
spec
  Type:        JSONB NOT NULL / DashboardSpec
  Properties:  Create, Update
  Description: The dashboard composition.
                 spec.template_id — layout grid id ('1x1' / '2x2' /
                   'kpi-row-2x1' / 'chart-side-table' / 'header-3x2').
                   Unknown ids fall back to '1x1' (single full-width
                   widget).
                 spec.widgets[] — array of Widget objects, each
                   { slot, kind, spec: <kind-specific> }.
               Updates replace the whole blob via PUT
               /api/dashboards/:rid (the designer's chart-widget
               append rebuilds + PUTs the full spec).
```

```
is_favorite
  Type:        BOOLEAN NOT NULL DEFAULT FALSE / bool
  Properties:  Update, Layout
  Description: Star toggle. Set via PATCH /api/dashboards/:rid
               or via the convenience POST /:rid/favorite. Drives
               the star affordance on the Home Dashboards tab.
               NOT a Create-property — every new dashboard lands
               un-favorited.
```

```
is_public
  Type:        BOOLEAN NOT NULL DEFAULT FALSE / bool
  Properties:  Update, Layout
  Description: Publish flag. Added mig 019. When true, every csv
               that sources a chart in this dashboard's widgets
               rolls up to stage 'publish' via the file_stages
               view (see [project](project.md#enum-constraints)).
               Set via PATCH `is_public`. NOT a Create-property —
               publish is an explicit gesture post-creation.
```

```
folder
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable, Search, Layout
  Description: Free-text folder label for grouping dashboards in
               the Home tab. Inline-editable. Hidden by default.
               No FK; folders are pure string labels (no separate
               folder table — the design choice keeps the
               taxonomy lightweight).
```

```
created_at, updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT / bumped on every UPDATE.
```

### Hydrated read-only fields

```
owner_id, owner_display_name, owner_username
  Type:        TEXT / Option<String>  (display_name + username: Option<String>)
  Properties:  Nillable, Sort (owner_display_name only), Layout
  Description: projects.owner_id → users JOIN. Populated by
               list endpoints (the Home Dashboards tab's
               "Owner" column); single-row fetchers
               (`GET /api/dashboards/:rid`) leave them unset.
               #[serde(default)] keeps the wire shape
               permissive in both directions.
```

---

## Widgets — the spec.widgets[] inner shape

Widget kinds (5 today, 1 surfaced — `chart`; others deferred):

| `kind` | spec shape | Status |
|---|---|---|
| `chart` | `{ chart_id, title_override? }` | Live. References a saved Chart row (CHT_); the dashboard decides where to render it. |
| `kpi` | TBD | Deferred — frontend has no `kpi` widget renderer today. |
| `table` | TBD | Deferred. |
| `text` | `{ markdown }` | Schema lands; renderer TBD. |
| `report` | TBD | Deferred. Likely supersedes the standalone Report derived view (see [report](report.md)). |

Slot ids are template-relative:
- `1x1` template: one slot (`'a'`).
- `2x2`: four slots (`'a'`, `'b'`, `'c'`, `'d'`).
- `kpi-row-2x1`: `'kpi-1' / 'kpi-2' / 'a'` (two KPI tiles + one widget).
- `chart-side-table`: `'a' / 'b'` (chart left, table right).
- `header-3x2`: `'header' / 'a' / 'b' / 'c'` (header row over a 3-up).

Widgets are mounted by `frontend/scripts/designer.js` — when a chart
widget's `chart_id` is missing or 404s, the slot renders an error
tile (no CASCADE on the soft-ref).

---

## Enum constraints

`spec.template_id ∈ { '1x1', '2x2', 'kpi-row-2x1',
'chart-side-table', 'header-3x2' }` — enforced **client-side** in
the designer's template picker. Unknown ids on read fall back to
`1x1` (single full-width widget) — graceful degrade, no error.

`spec.widgets[].kind ∈ { chart, kpi, table, text, report }` —
enforced client-side. Backend stores opaque JSON. The chart kind
is the only one with a live renderer today; the others are
schema-only.

`file_type ∈ { dashboard }` for this object (per the canonical
row's discriminator in [file](file.md#enum-constraints)).

---

## Relationships

```
project_redpash_id → Project (PRJ_)
  Cardinality:  N:1 (a Project has many Dashboards)
  On delete:    CASCADE
  Hydrated as:  owner_* fields (joined through projects.owner_id)
```

```
spec.widgets[].spec.chart_id → Chart (CHT_, soft ref via JSONB)
  Cardinality:  N:N (many dashboards can reference one chart; one
                dashboard can reference many charts)
  On delete:    No FK — deleting a chart leaves dangling widget
                references that the designer renders as error tiles.
                Worth noting: the publish-flag rollup recalculates
                at SELECT time, so a deleted chart simply
                disappears from the publish set on the next read.
```

### Inverse relationships

```
Dashboard has no FK-rooted sub-rows.
The widget refs are soft (JSONB).
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `dashboard_create` | `POST /api/dashboards` | `{ dashboard, project, title }` |
| `dashboard_update` | `PUT /api/dashboards/:rid` | `{ dashboard, title }` — full replace; no per-widget diff |
| `dashboard_patch` | `PATCH /api/dashboards/:rid` | `{ dashboard, fields: [<names>] }` — bundled summary for the sparse meta path (title / description / folder / is_favorite / is_public) |
| `dashboard_delete` | `DELETE /api/dashboards/:rid` | `{ dashboard }` |

The `dashboard_update` vs `dashboard_patch` split mirrors the
update verb split: PUT does the spec replace (designer's chart-
widget append + reorder), PATCH does the inline-edit meta cells.
Future work could add per-field events on the PATCH path
(`dashboard_publish_change` for `is_public` flips — high-signal
when publish gates downstream stage rollups) but today the
bundled `fields:[...]` carries the change set.

No `dashboard_favorite_change` event from the convenience
`/favorite` endpoint; it shares the PATCH emit path
(`dashboard_patch` with `fields: ['is_favorite']`).
