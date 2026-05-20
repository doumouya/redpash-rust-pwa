---
title: Reports page (`#/reports`)
section: Frontend
order: 16
last modified date: 2026-05-16
---

# Reports page (`#/reports`)

A **report** is a saved group-by spec over one project file — group-by
columns + aggregations + a chart spec or two + an optional filter. The
page is two modes glued together: a **list mode** (saved reports, by
folder, with the redtable on it) and a **builder mode** (the live spec
editor with a real-time preview).

The list mode IS a redtable; the builder is **not** — its data model
is a pre-aggregated spec, not a raw row table, so it paints a custom
preview pane. See [redtable](../../redpash-components/redtable.md) for
the shared chrome and the [Objects page](../objects-page/index.md) for
the canonical list pattern (the reports list is mostly the *Reports*
tab of Objects, lifted onto its own URL for builder-flow continuity).

## Files

| File | Role |
|---|---|
| [`partials/reports.html`](../../../../frontend/partials/reports.html) | Two `<section>` mode hosts (`#reports-list`, `#reports-builder`), the chart modal (`#chart-modal`), and the slot landmarks the builder paints into. |
| [`styles/pages/reports.css`](../../../../frontend/styles/pages/reports.css) | Layout grid for the builder's three-pane editor, chart-category icon grids, the report preview table, folder group headers. |
| [`scripts/reports/index.js`](../../../../frontend/scripts/reports/index.js) | The controller. Owns the `spec` state, all `_render*` functions for the builder, the chart modal pipeline, the debounced preview-fetcher, save / load / undo / redo, folder autocomplete. |

---

## Two modes, one URL

| Hash | Mode | What it shows |
|---|---|---|
| `#/reports` | List | Saved reports table (folder groups + favorites + per-row open / delete). The `#reports-list` section is unhidden; `#reports-builder` stays hidden. |
| `#/reports?new=1` | Builder (create) | Blank spec, `STATE.rid = null`. Save → `POST /api/reports` → URL switches to `?id=RPT_…`. |
| `#/reports?id=RPT_…` | Builder (edit) | Loads the report's spec into the builder, `STATE.rid = RPT_…`. Save → `PATCH /api/reports/:rid`. |

The controller listens on `hashchange` and toggles the two sections by
unhiding the right one + calling the right loader.

---

## Builder STATE shape

```js
{
  rid,               // RPT_… when editing, null when creating
  spec: {
    source_file_id,        // FIL_…
    group_by,              // [colName, …] — rollup dimensions
    group_by_cols,         // [colName, …] — pivot-style cols (Phase B)
    aggregations,          // [{ col, fn, alias? }, …]
    filter,                // FilterNode tree (or null)
    show_details,
    show_subtotals,
    show_total,            // toggles for the preview table sections
    sort,                  // [{ col, dir }, …] applied after aggregation
    charts,                // [ChartSpec, …] — independent /preview runs per chart
    top_n,                 // { n, by: colName, dir } — post-agg head() spec
    windows,               // [WindowSpec, …] — derived columns (lag, lead, pct_of_group, …)
  },
  sourceFiles,       // available files (for the source picker)
  currentColumns,    // ColumnMeta[] of the selected source file (drives every column picker)
  sourceRowCount,    // shown in the subtitle as a context line
  knownFolders,      // [string] for the folder datalist
  isFavorite,        // gold-star toggle (PATCH .is_favorite)
  history,           // undo/redo over the `spec` object
  previewTimer,      // 350ms debounce handle for the live preview
}
```

The whole `spec` is what `POST /api/reports/preview` consumes — see
[`api/reports.md`](../../../api/reports.md) for the response shape
(`{ details, subtotals, total, ms }`).

---

## Header chrome (builder mode)

| Element | ID | Source |
|---|---|---|
| Title | `#report-title` | `spec.title` — free text |
| Folder | `#report-folder` + `#report-folders-list` | text input with `<datalist>` autocomplete; populated from `knownFolders` (harvested from `/api/reports` on builder mount) |
| Source file | `#report-source` | select of the project's files; switching triggers a column re-fetch + `currentColumns` repopulation |
| Favorite | `#report-fav` | `PATCH /api/reports/:rid { is_favorite: true|false }` — gold star, only visible when editing (`STATE.rid` set) |
| Undo / Redo | (header) | walks the `history` cursor over `spec` |
| Save | (header) | `POST /api/reports` (create) or `PATCH /api/reports/:rid` (update); persists `knownFolders` to `prefs.reports_folders` via `rpSavePref()` |

---

## Three-pane editor

The body of `#reports-builder` is a CSS grid:

| Pane | What lives here |
|---|---|
| **Left** | `#chart-add-sections` — chart-category icon grid (Aggregated / Raw / 2-dim / Scalar) with one button per chart kind. `#chart-list` — the list of saved chart specs on this report, each with a thumbnail + edit/remove affordances. |
| **Center** | `#report-preview` — the live preview. Renders the **details** rows (raw / windowed columns), **subtotals** by group, and **total** as toggled by `spec.show_*`. Pulls from `POST /api/reports/preview` debounced 350ms on every spec change. |
| **Right** | `#reports-filters` — the filter panel host (shared with the cleaner's filter panel via `/scripts/cleaner/filters/panel.js`; reports has no real redtable so the panel talks to a mock `table` object). Below it: the **grouping** chips (`spec.group_by` add / remove), the **aggregations** list (`spec.aggregations` add / edit / remove with col + fn + optional alias inputs), and **Top N** + **Window** spec rows. |

---

## Chart modal (`#chart-modal`)

The per-chart spec editor. Opens via "+ Add chart" or by clicking an
existing chart in `#chart-list`. The modal carries 11 conditional rows
that show/hide based on the chart `kind`:

| Field | When |
|---|---|
| `kind` | always (line / area / bar / bar_horizontal / pie / funnel / pictorial_bar / calendar / gauge / scatter / heatmap / radar / boxplot) |
| `title` | always (optional) |
| `group_by` | aggregated kinds, heatmap/radar (x), scatter (x), calendar (date) |
| `y_group_by` | heatmap / radar (Y dim) |
| `agg_fn` | aggregated kinds — count / sum / mean / min / max / … |
| `agg_col` | aggregated kinds, scatter (y), boxplot (value); `"*"` = row count |
| `regression` | scatter only — linear / exponential / logarithmic / polynomial (fitted client-side via ecStat) |
| `symbol`, `symbol_repeat` | pictorial_bar only — ECharts symbol name / `path://` SVG; repeat=tile, no-repeat=stretch |
| `smooth` | line / area only — spline interpolation |
| `donut`, `half`, `rose` | pie only — annular ring, semi-circle, Nightingale |

Apply runs the chart's `/reports/preview` body against the report's
source file with the report's filter, threads the response through
[`chart-render.js`](../../../../frontend/scripts/charts/chart-render.js),
and pins the result into `#chart-list` as a thumbnail. The chart's
fields are merged into `spec.charts[i]`; saving the report serialises
all charts together.

See [`objects/chart.md`](../../../objects/chart.md) for `ChartSpec`
and [`features/charts.md`](../../../features/charts.md) for the
rendering pipeline.

---

## Live preview

On every spec change, `previewTimer` debounces 350ms then POSTs to
`/api/reports/preview` with the active `spec`. The response carries:

- **`details`** — the raw post-filter rows (when `show_details`).
- **`subtotals`** — group-by rollups (when `show_subtotals`).
- **`total`** — single grand-total row (when `show_total`).
- **`ms`** — server-measured render time, shown as a fine-print badge.

`#report-preview` paints all three sections as separate `<table>`
chunks, with the subtotals + total visually offset so the user can
read them as summaries rather than data rows.

---

## Folder autocomplete

The folder field is a text input with a `<datalist>` (`#report-folders-list`).
`refreshFolderList()` (called on builder mount and after every save)
collects distinct `folder` values from `/api/reports` + the user's
`prefs.reports_folders` cache and writes them into the datalist. Typing
a folder name that doesn't exist creates it on save — no separate
"new folder" step.

Same pattern is used in [Dashboards](../dashboards-page/index.md) and
in the upload modal's project picker.

---

## List mode (`#reports-list`)

The list mode is currently the **Reports tab on the
[Objects page](../objects-page/index.md)** lifted onto its own URL —
same schema-driven redtable, same row click → builder hand-off, same
delete affordance. The dedicated `#reports-list` rendering inside this
page is reserved for the Phase-3+ "folder-grouped richer browse" view
(folder collapse, per-folder favorites, drag-to-reorder); today it
just renders the Objects-style table for continuity.

---

## Wired vs stubbed

| Surface | Endpoint | Status |
|---|---|---|
| List reports | `GET /api/reports` | ✅ live |
| Load for edit | `GET /api/reports/:rid` | ✅ live |
| Create | `POST /api/reports` | ✅ live |
| Update | `PATCH /api/reports/:rid` | ✅ live |
| Delete | `DELETE /api/reports/:rid` | ✅ live (from the Objects' Reports tab) |
| Live preview | `POST /api/reports/preview` (debounced 350ms) | ✅ live |
| Favorite toggle | `PATCH /api/reports/:rid { is_favorite }` | ✅ live |
| Folder cache | `prefs.reports_folders` via `PATCH /api/me` | ✅ live |
| Share / publish | `is_public` toggle on the row + share URL | ⛔ schema-ready (`reports.is_public` exists), no UI yet |
| Phase-3+ folder-grouped list view | — | ⛔ falls back to Objects-style table today |

---

## Cache / refresh

Every change to the partial, CSS, or controller triggers a
`service-worker.js` `CACHE_VERSION` bump. Hard-refresh (or Firefox
private — the dev server's `ServeDir` sends no `Cache-Control`).

---

## Related

- [Dashboards page](../dashboards-page/index.md) — references reports via `chart_index` widget refs.
- [Objects page](../objects-page/index.md) — hosts the canonical Reports list (same redtable today).
- [redtable](../../redpash-components/redtable.md) — shared chrome.
- [API: reports](../../../api/reports.md) — preview / create / update endpoints.
- [Chart object](../../../objects/chart.md) — `ChartSpec`.
- [Features: charts](../../../features/charts.md) — rendering pipeline.
