---
title: Dashboard
section: Objects
order: 2
last modified date: 2026-05-30
---

# Dashboard

A `project_files` row with `file_type='dashboard'` — there is no separate
`dashboards` table ("everything is a File"). Source: `shared::dashboard`.

## Dashboard

| Field                 | Type                  | Notes |
|-----------------------|-----------------------|-------|
| `redpash_id`          | `String`              | Primary key. New dashboards mint `FIL_…` (`routes::dashboards::create`); ones predating the mig-017 fold kept their original `DSH_…` rid |
| `project_redpash_id`  | `String`              | FK → `projects.redpash_id` |
| `title`               | `String`              | |
| `description`         | `Option<String>`      | |
| `spec`                | [`DashboardSpec`](#dashboardspec) | Persisted as JSONB |
| `is_favorite`         | `bool`                | |
| `is_public`           | `bool`                | Phase 4 share-toggle |
| `folder`              | `Option<String>`      | |
| `owner_id`            | `Option<String>`      | FK → `users.redpash_id`, resolved via the project's owner membership. `None` when the fetcher skipped the users join (single-row endpoints) |
| `owner_display_name`  | `Option<String>`      | From the users join — populated by the list endpoint for the Dashboards tab |
| `owner_username`      | `Option<String>`      | From the users join |
| `created_at`          | `DateTime<Utc>`       | |
| `updated_at`          | `DateTime<Utc>`       | |

## DashboardSpec

```rust
pub struct DashboardSpec {
    pub template_id: String,        // persisted but currently unused (see below)
    pub widgets:     Vec<Widget>,
}
```

`template_id` is **persisted but not used for layout** — the designer
ignores it and round-trips it (`""` or `"free"`). The canvas is a fixed
12-column CSS grid; dashboard tiles mount at `span-6`, a lone-chart canvas
at `span-12`. There is no template registry — the named-template idea
(`1x1`/`2x2`/`kpi-row-2x1`/…) was never implemented.

## Widget

```rust
pub struct Widget {
    pub slot: String,                 // widget id, e.g. "w1" (no template binding yet)
    pub kind: String,                 // "chart" | "text" (only "chart" is rendered today)
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
    "title_override": "Q3 funnel"    // optional — defined in the DTO, not yet honored by the canvas
  }
}
```

The widget renderer fetches the referenced chart by `chart_id`
(`GET /api/charts/:rid`), re-aggregates its spec against the chart's
`source_file_id` via `POST /api/group/preview`, and draws it with
`buildOption` from `charts/build.js` (the same builder the chart editor
uses). Reports-as-entities were retired in the object-model refresh — a
widget references a chart directly, not a `(report_id, chart_index)` pair.

### `kind: "text"` — markdown block

```jsonc
{
  "slot": "hdr",
  "kind": "text",
  "spec": { "markdown": "## Q3\n\nSummary text." }
}
```

Defined in the DTO, but **not rendered by the current canvas** —
`load()` filters widgets to `kind === "chart"` and drops the rest. Text
(and any markdown rendering) is a TODO.

## Legacy widgets

Old dashboards had `kpi` / `table` / `report` kinds plus a `chart` shape
with inline `group_by` / `agg_col` / `agg_fn`. There is no normaliser —
the canvas simply **drops** any widget whose `kind` isn't `"chart"` on
load, so legacy non-chart widgets silently disappear and need to be
re-added as chart widgets.

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
