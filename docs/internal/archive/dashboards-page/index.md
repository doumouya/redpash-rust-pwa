---
title: Dashboards page (`#/dashboards`)
section: Frontend
order: 18
last modified date: 2026-05-16
---

# Dashboards page (`#/dashboards`)

A **dashboard** is a layout — a template (`2x2`, `1x1`, `kpi-row-2x1`,
`chart-side-table`, `header-3x2`) with one widget per slot. Widgets are
either **chart-refs** (pointers into a saved report's `charts[]`) or
**markdown text** blocks. Dashboards don't read raw file data — they
read pre-aggregated report results, so the page has **no redtable**.
The list lives on the [Objects page](../objects-page/index.md)
(*Dashboards* tab) today; this URL is the builder.

See also: [reports page](../reports-page/index.md) (the source of every
chart-ref), [Dashboard object](../../../objects/dashboard.md)
(`DashboardSpec` / `Widget` shapes).

## Files

| File | Role |
|---|---|
| [`partials/dashboards.html`](../../../../frontend/partials/dashboards.html) | Two `<section>` mode hosts (`#dashboards-list`, `#dashboards-builder`). Builder is a two-pane editor — preview on the left, template selector + slot editor on the right. |
| [`styles/pages/dashboards.css`](../../../../frontend/styles/pages/dashboards.css) | Template grid layouts (one CSS class per `template_id`), slot editor row styling, widget thumbnails. |
| [`scripts/dashboards/index.js`](../../../../frontend/scripts/dashboards/index.js) | The controller. Owns `dashSpec`, the slot editor pipeline, the preview renderer, save / load / undo / redo, folder autocomplete. |
| [`scripts/dashboards/templates.js`](../../../../frontend/scripts/dashboards/templates.js) | The `TEMPLATES` registry — `template_id` → grid spec (slot ids + CSS class). |
| [`scripts/dashboards/widgets.js`](../../../../frontend/scripts/dashboards/widgets.js) | `renderWidget(widget, ctx)` — runs the widget's `/reports/preview` body, hands the response to `chart-render.js`, or renders markdown for text widgets. |

---

## Two modes, one URL

| Hash | Mode | What it shows |
|---|---|---|
| `#/dashboards` | List | Saved dashboards table (folder groups + favorites + per-row open / delete). The `#dashboards-list` section unhides; `#dashboards-builder` stays hidden. |
| `#/dashboards?new=1` | Builder (create) | Blank dashSpec, `STATE.rid = null`. Save → `POST /api/dashboards` → URL switches to `?id=DSH_…`. |
| `#/dashboards?id=DSH_…` | Builder (edit) | Loads the dashboard's spec into the builder, `STATE.rid = DSH_…`. Save → `PATCH /api/dashboards/:rid`. |

`hashchange` listener toggles the sections.

---

## Builder STATE shape

```js
{
  rid,               // DSH_… when editing, null when creating
  project,           // Project (for the project meta line, scope check)
  isFavorite,
  projectReports,    // [Report] — available reports for chart-ref widgets, fetched once per builder open
  knownFolders,      // [string] for the folder datalist
  dashSpec: {
    template_id,            // "1x1" | "2x2" | "kpi-row-2x1" | "chart-side-table" | "header-3x2"
    widgets: [               // one per slot defined by the template
      { slot, kind: "chart", spec: { report_id, chart_index, title_override? } },
      { slot, kind: "text",  spec: { markdown } },
      // …
    ],
  },
  previewTimer,      // debounce for re-rendering the preview on slot edits
  history,           // undo/redo over `dashSpec`
}
```

`DashboardSpec` + `Widget` are documented in
[`objects/dashboard.md`](../../../objects/dashboard.md). Legacy
widget shapes (`kpi`, `table`, the older inline-chart `chart` without
`report_id`) get normalised on load — `kpi` / `table` → blank `chart`
widgets, inline-chart with no `report_id` → empty spec — both end up
showing "Pick a report" in the slot editor and need a one-time
re-config by the user.

---

## Header chrome (builder mode)

| Element | ID | Source |
|---|---|---|
| Title | `#dashboard-title` | `dashSpec.title` |
| Folder | `#dashboard-folder` + `#dashboard-folders-list` | text input + `<datalist>` autocomplete; populated from `knownFolders` (harvested from `/api/dashboards`) — same pattern as [reports](../reports-page/index.md#folder-autocomplete). |
| Favorite | `#dashboard-fav` | `PATCH /api/dashboards/:rid { is_favorite }` — visible when editing |
| Undo / Redo | (header) | walks the `history` cursor over `dashSpec` |
| Save | (header) | `POST /api/dashboards` / `PATCH /api/dashboards/:rid`; persists `knownFolders` to `prefs.dashboards_folders` via `rpSavePref()` |

---

## Two-pane editor

| Pane | What lives here |
|---|---|
| **Left — `#dashboard-preview`** | The rendered dashboard. Picks the CSS grid for `dashSpec.template_id` and paints each widget into its slot. Chart widgets run the referenced report's `/reports/preview` body (cached per session via `reportCache`), pull `report.spec.charts[chart_index]`, and render through [`chart-render.js`](../../../../frontend/scripts/charts/chart-render.js). Text widgets render through a tiny inline markdown parser (headers `#` / `##`, paragraphs, **bold**, *italic*, `code` — full markdown is intentional overkill here). Re-paints on every slot edit, debounced. |
| **Right — `.rp-dashboards__tools`** | Template selector (`#dashboard-template` — select of `TEMPLATES` keys; switching it reshapes `dashSpec.widgets` to the new slot list, preserving overlapping slots). Below it: `#dashboard-slots` — one row per template slot, each row is a widget picker: choose **chart** or **text**, then fill the spec (report + chart_index dropdown for charts, textarea for markdown). |

---

## Templates

`TEMPLATES` in [`templates.js`](../../../../frontend/scripts/dashboards/templates.js)
maps `template_id` → `{ name, slots: [{ id, label, area }], css }` where
`area` is the slot's CSS-grid `grid-area` and `css` is the wrapper
class. Built-ins:

| `template_id` | Layout |
|---|---|
| `1x1` | one big slot |
| `2x2` | four equal quadrants (a / b / c / d) |
| `kpi-row-2x1` | three KPI cells across the top + one wide chart below |
| `chart-side-table` | one large chart + a sidebar table widget |
| `header-3x2` | a header (markdown) + a 3×2 chart grid |

Unknown `template_id` falls back to `1x1`. Adding a new template is
one entry in `TEMPLATES` + one CSS rule.

---

## Widget shapes

### `kind: "chart"` — chart-ref widget

```jsonc
{
  "slot": "a",
  "kind": "chart",
  "spec": {
    "report_id":      "RPT_…",       // required — the source report
    "chart_index":    0,             // index into report.spec.charts
    "title_override": "Q3 funnel"    // optional — defaults to the report's chart.title
  }
}
```

Renderer flow (in [`widgets.js`](../../../../frontend/scripts/dashboards/widgets.js)):

1. Cache lookup — `reportCache.get(report_id)`. Miss → `GET /api/reports/:report_id`.
2. Pick `report.spec.charts[chart_index]`.
3. Build a `/reports/preview` body from `report.spec` (keeps the same filter / group_by / aggregations as the report) plus the chart's own group_by + agg_fn.
4. `POST /api/reports/preview` → run through `chart-render.js`.

### `kind: "text"` — markdown block

```jsonc
{
  "slot": "hdr",
  "kind": "text",
  "spec": { "markdown": "## Q3\n\nSummary text." }
}
```

---

## Folder autocomplete

Same `text input` + `<datalist>` pattern as
[reports' folder autocomplete](../reports-page/index.md#folder-autocomplete).
`refreshFolderList()` collects distinct `folder` values from
`/api/dashboards` + `prefs.dashboards_folders` and writes them into
`#dashboard-folders-list`. Typing a folder name that doesn't exist
creates it on save.

---

## List mode (`#dashboards-list`)

Like [reports](../reports-page/index.md#list-mode-reports-list), the
**list mode** is currently the *Dashboards* tab on the
[Objects page](../objects-page/index.md) lifted onto its own URL —
same schema-driven redtable, same row click → builder hand-off, same
delete affordance. A folder-grouped richer browse view is Phase-3+.

---

## Wired vs stubbed

| Surface | Endpoint | Status |
|---|---|---|
| List dashboards | `GET /api/dashboards` | ✅ live |
| Load for edit | `GET /api/dashboards/:rid` | ✅ live |
| Create | `POST /api/dashboards` | ✅ live |
| Update | `PATCH /api/dashboards/:rid` | ✅ live |
| Delete | `DELETE /api/dashboards/:rid` | ✅ live (from the Objects' Dashboards tab) |
| Favorite toggle | `PATCH /api/dashboards/:rid { is_favorite }` | ✅ live |
| Folder cache | `prefs.dashboards_folders` via `PATCH /api/me` | ✅ live |
| Widget preview | `POST /api/reports/preview` (per chart widget, cached) | ✅ live |
| Share / publish | `is_public` toggle on the row + share URL | ⛔ schema-ready (`dashboards.is_public` exists), no UI yet |
| Phase-3+ folder-grouped list view | — | ⛔ falls back to Objects-style table today |

---

## Cache / refresh

Every change to the partial, CSS, or controller triggers a
`service-worker.js` `CACHE_VERSION` bump. Hard-refresh or use Firefox
private — see [Cache note in the redtable doc](../../redpash-components/redtable.md#cache--refresh).

---

## Related

- [Reports page](../reports-page/index.md) — the source of every chart-ref widget.
- [Objects page](../objects-page/index.md) — hosts the canonical Dashboards list today.
- [redtable](../../redpash-components/redtable.md) — context for the list mode.
- [Dashboard object](../../../objects/dashboard.md) — `DashboardSpec` / `Widget` shapes.
- [Chart object](../../../objects/chart.md) — `ChartSpec`.
- [Features: charts](../../../features/charts.md) — rendering pipeline (shared with reports).
