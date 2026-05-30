---
title: Dashboard
section: Objects
order: 2
last modified date: 2026-05-30
---

# Dashboard

Persisted row in the `dashboards` table. Source: `shared::dashboard`.

## Dashboard

| Field                 | Type                  | Notes |
|-----------------------|-----------------------|-------|
| `redpash_id`          | `String` (`DSH_…`)    | Primary key |
| `project_redpash_id`  | `String`              | FK → `projects.redpash_id` |
| `title`               | `String`              | |
| `description`         | `Option<String>`      | |
| `spec`                | [`DashboardSpec`](#dashboardspec) | Persisted as JSONB |
| `is_favorite`         | `bool`                | |
| `is_public`           | `bool`                | Phase 4 share-toggle |
| `folder`              | `Option<String>`      | |
| `owner_id`            | `Option<String>`      | FK → `users.redpash_id`, joined via `projects.owner_id`. `None` when the fetcher skipped the users join (single-row endpoints) |
| `owner_display_name`  | `Option<String>`      | From the users join — populated by the list endpoint for the Dashboards tab |
| `owner_username`      | `Option<String>`      | From the users join |
| `created_at`          | `DateTime<Utc>`       | |
| `updated_at`          | `DateTime<Utc>`       | |

## DashboardSpec

```rust
pub struct DashboardSpec {
    pub template_id: String,        // see templates below
    pub widgets:     Vec<Widget>,
}
```

Known `template_id` values come from `frontend/scripts/dashboards/templates.js`:
`1x1`, `2x2`, `kpi-row-2x1`, `chart-side-table`, `header-3x2`.
Unknown ids render as `1x1`.

## Widget

```rust
pub struct Widget {
    pub slot: String,                 // matches a slot id in the template
    pub kind: String,                 // "chart" | "text"
    pub spec: serde_json::Value,      // shape varies by kind
}
```

### `kind: "chart"` — chart-ref widget

```jsonc
{
  "slot": "a",
  "kind": "chart",
  "spec": {
    "chart_id":       "CHT_…",       // required — references a saved chart (project_files row)
    "title_override": "Q3 funnel"    // optional — defaults to the chart's title
  }
}
```

The widget renderer fetches the referenced chart by `chart_id`
(`GET /api/charts/:rid`), re-aggregates its spec against the chart's
`source_file_id` via `POST /api/group/preview`, and renders through
`charts/render.js`. (Reports-as-entities were retired in the object-model
refresh — a widget references a chart directly, not a `(report_id,
chart_index)` pair.)

### `kind: "text"` — markdown block

```jsonc
{
  "slot": "hdr",
  "kind": "text",
  "spec": { "markdown": "## Q3\n\nSummary text." }
}
```

Renders via a tiny inline markdown parser — headers (`#`, `##`),
paragraphs, **bold**, *italic*, `code`. Full markdown is intentional
overkill here.

## Legacy widgets

Old dashboards had `kpi` / `table` kinds plus a `chart` shape with
inline `group_by` / `agg_col` / `agg_fn`. The controller normalises
on load:

- `kpi` / `table` → converted to `kind: "chart"` with empty spec.
- `chart` without `chart_id` → spec blanked.

Both end up showing "Pick a chart" in the slot editor and need a
one-time re-config from the user.

## Request body

```rust
pub struct DashboardRequest {
    pub project_redpash_id: String,
    pub title:              String,
    pub spec:               DashboardSpec,
    pub description:        Option<String>,
    pub folder:             Option<String>,
}
```
