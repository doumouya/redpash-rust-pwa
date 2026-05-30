---
title: Dashboards
section: Features
order: 2
last modified date: 2026-05-30
---

# Dashboards

A **dashboard** is a layout of chart tiles. Each tile references a saved
chart by **`chart_id`** (`CHT_…`); the dashboard only decides *where* the
charts sit, while each chart owns its own spec + source file.

Like charts, a dashboard is not a table of its own — it is a
`project_files` row with `file_type='dashboard'` ("everything is a File").
New dashboards mint a `FIL_` rid (`routes/dashboards.rs` `id::new("FIL")`);
dashboards that predate the mig-017 fold kept their original `DSH_` rid.
The `spec` (a `DashboardSpec`) is stored as JSONB. See
[objects/dashboard.md](../objects/dashboard.md) for the full DTO.

## Layout

The dashboard builder is the **designer canvas** in the workspace
(`scripts/designer.js` `mountDesigner`), opened when you select a
chart-typed or dashboard-typed file:

```
┌────────────────────────────────┬──────────────────────┐
│ .ds-canvas / .ds-grid          │ .ds-config (aside)   │
│   12-column CSS grid            │  chart-spec accordion│
│   chart tiles (span-6 / -12)    │  Type / Data / Axes  │
│   each tile = one ECharts inst, │  / Legend / Tooltip  │
│   drawn via buildOption()       │  / Style             │
└────────────────────────────────┴──────────────────────┘
```

There is no source picker and no per-dashboard filter: each tile carries
its own `chart_id`, so different tiles can pull from different charts (and
therefore different source files).

## Grid

The canvas is a fixed **12-column CSS grid** (`.ds-grid` in
`styles/chart.css`). Tiles get span classes (`.span-3/5/6/7/12`); the
designer mounts dashboard widgets at **`span-6`** (two-up) and a
lone-chart canvas at **`span-12`**.

> There is **no template registry**. `DashboardSpec.template_id` is
> persisted but currently unused — the designer ignores it for layout and
> just round-trips it (`""` or `"free"`). Slot/template-aware sizing
> (named layouts, per-slot spans) is a TODO; don't document the old
> `1x1`/`2x2`/`kpi-row-2x1`/… templates as if they exist — they never
> shipped.

## Widgets

A widget is `{ slot, kind, spec }`. Two kinds are defined:

```jsonc
// chart — references a saved chart by id.
{ "slot": "w1", "kind": "chart", "spec": { "chart_id": "CHT_…" } }

// text — markdown block.
{ "slot": "hdr", "kind": "text", "spec": { "markdown": "## Q3\n\nNumbers below." } }
```

> The canvas currently renders **chart widgets only** — `load()` filters
> to `kind === "chart"` and drops the rest. `text` widgets (and the
> `title_override` field on a chart spec) are part of the DTO but not yet
> rendered by the designer. Legacy `kpi` / `table` / `report` kinds from
> pre-refresh dashboards are dropped on load, not normalised.

## How a chart tile renders

`load(payload)` in `designer.js`:

1. Take `dashboard.spec.widgets`, filter to `kind === "chart"`.
2. **Fetch each chart in parallel** by id — `GET /api/charts/:rid` via
   `Promise.all`. A `404` means the chart was deleted: the dead widget is
   pruned from the spec and the dashboard is **self-healed** with a
   `PUT /api/dashboards/:rid`. Other errors render a recoverable error
   tile.
3. Each fetched chart → `mountChartTile(...)`: `mergeCfg(chart)` projects
   the saved `chart.spec` into a render cfg, then
   `echarts.init(...).setOption(buildOption(cfg, theme))`. `buildOption`
   lives in `scripts/charts/build.js` — the same builder the chart editor
   uses, so a chart looks identical embedded vs. authored.
4. **Re-aggregation** (`reaggregate`): the tile builds a minimal grouping
   spec from the chart's own `group_by` + `agg_col`/`agg_fn` and posts
   `{ source_file_id, spec }` to **`POST /api/group/preview`**, then bakes
   `subtotals.rows` into the ECharts option (label = first cell, value =
   last). `count(*)` is mapped to a count over the group-by column to
   dodge a Polars literal-aggregation bug.

## Editing flows

- **+ New dashboard** (rail) — `POST /api/dashboards` with
  `spec: { template_id: "free", widgets: [] }`, then opens it.
- **Add chart** (designer toolbar) — if the canvas is just a lone chart
  it is **promoted to a real dashboard first** (see below); then
  `POST /api/charts` mints an `Untitled chart` against a resolved source
  file and `addChartWidget(chart)` appends
  `{ slot, kind:"chart", spec:{ chart_id } }` and **PUTs the whole
  dashboard**.
- **Promote-to-dashboard** — a single chart opens as a synthetic
  one-widget wrapper (read-only). Promoting it does
  `POST /api/dashboards` with that one `chart_id` as the first widget,
  turning it into a savable, multi-chart dashboard.
- **Inline title rename** — the tile-header title is `contentEditable`;
  Enter/blur commits to the chart's cfg, Esc cancels. It marks the tile
  dirty, so it persists on the **per-tile chart save**.

### Two distinct saves

| Save | Endpoint | Persists |
|------|----------|----------|
| **Per-tile chart save** (tile-head button) | `PUT /api/charts/:rid` | the tile's chart cfg + baked option — chart config, not the dashboard |
| **Whole-dashboard save** (builder header) | `PUT /api/dashboards/:rid` | `template_id` + the widget `chart_id` refs only. No-op (with a hint) when the canvas is a synthetic lone-chart wrapper |

`delete` removes the chart (`DELETE /api/charts/:rid`) and prunes the
widget; `close` drops the widget ref without deleting the chart.

## DashboardSpec

```jsonc
{
  "template_id": "free",
  "widgets": [
    { "slot": "w1", "kind": "chart", "spec": { "chart_id": "CHT_…" } },
    { "slot": "w2", "kind": "chart", "spec": { "chart_id": "CHT_…" } }
  ]
}
```

See [objects/dashboard.md](../objects/dashboard.md) for the full DTO.

## Endpoints

| Method | Path                              | Notes |
|--------|-----------------------------------|-------|
| GET    | `/api/dashboards`                 | List (owner-scoped; sorted folder, favorite, updated_at desc) — `{ items: [...] }` |
| POST   | `/api/dashboards`                 | Create — body = `DashboardRequest` `{ project_redpash_id, title, spec, description?, folder? }` |
| GET    | `/api/dashboards/:rid`            | Fetch one |
| PUT    | `/api/dashboards/:rid`            | Full replace of title/spec/folder/description |
| PATCH  | `/api/dashboards/:rid`            | Sparse update `{ title?, description?, folder?, is_favorite?, is_public? }` (inline Dashboards-tab cells) |
| DELETE | `/api/dashboards/:rid`            | Remove |
| POST   | `/api/dashboards/:rid/favorite`   | `{ value: bool }` |

All write handlers gate on `ensure_owner` (dashboard/project ownership via
memberships).
