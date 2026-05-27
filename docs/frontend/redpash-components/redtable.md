---
title: Redtable (app-side integration)
section: Frontend
order: 10
last modified date: 2026-05-16
---

# Redtable (app-side integration)

The **redtable** is the data-table surface that powers two pages —
[Objects](../redpash-components-pages/objects-page/index.md) and the
unified [Workspace](../../features/cleaner.md) (cleaner / report /
chart / dashboard modes all share the redtable canvas; the per-page
Cleaner / Reports list / Dashboards list docs were retired into
`docs/internal/archive/` when those pages folded into Workspace).
The component itself lives in the
[`redpash-components` library](/home/mansa/redpash-components/) as
`.rp-rt-*` markup + CSS; this doc covers how the **app** wires that
markup to its own data, schemas, and step pipeline.

Library reference (definitive — read these first if you need a class):

- [`03-data-table.md`](/home/mansa/redpash-components/03-data-table.md) — the base component (toolbar, table, footer, mode classes)
- [`07-redtable-schemas.md`](/home/mansa/redpash-components/07-redtable-schemas.md) — schema-driven rendering pattern
- [`08-cleaner-workspace.md`](/home/mansa/redpash-components/08-cleaner-workspace.md) — the cleaner's pro chrome (tabs, tools panel, Data Types list)

---

## Library vs app split

The **library** owns:

- The CSS architecture — `.rp-rt-panel`, `.rp-rt-header`, `.rp-rt-toolbar`, `.rp-rt-body`, `.rp-rt-table`, `.rp-rt-footer`, plus the mode classes (`rp-rt-mode-edit`, `rp-rt-mode-select`, `rp-rt-mode-delete`) and the "glass" control treatment.
- The pro chrome — `.rp-rtp` wrapper, `.rp-rtp-tabs`, `.rp-rtp-tools` side panel, `.rp-rtp-type-sep` (Data Types) and `.rp-rtp-join-panel` cards.
- The DOM landmarks the app paints into — every panel mount uses the same `[data-rt-slot]` host pattern.

The **app** owns:

- **Schema registries** — per-page JS objects describing what each row "kind" looks like (columns, render fns, edit specs, fetch URL, deleteOne).
- **STATE** — per-kind in-memory state (rows, selected, colOrder, visibleCols, mode, page, rowsPerPage, …).
- **Event handlers** that toggle modes, edit cells, dispatch steps, paginate, search, filter.
- **Data fetching** — `GET /api/files/:rid/page` for the cleaner's per-file rows; flat `GET /api/{kind}` for the Objects-style list views.

The two layers don't share state. The library hands the app a set of CSS landmarks; the app paints HTML into them. Toggling a mode class on `.rp-rt-panel` is the only "language" between them.

---

## Backend contract — `GET /api/files/:rid/page`

The cleaner's per-file redtable is server-paginated through one endpoint:

```
GET /api/files/:rid/page?page=1&size=25&sort=<col>&dir=asc&sorts=<json>&q=<text>&filters=<json>&cols=<csv>
```

`PageQuery` shape and pipeline order are documented in
[`api/files.md`](../../api/files.md#get-apifilesridpage); the response
is `Page<Row>` — `{ rows, total, all_count, page, size, pages, ms,
row_indices }`. `row_indices` are post-step-replay pre-filter absolute
indices so the frontend can build a precise `drop_rows` step under an
active filter.

The Objects-style pages (Projects / Files / Reports / Dashboards /
Companies / Users) use simpler flat list endpoints — `GET /api/files`,
`GET /api/projects`, etc. — no pagination on the wire, the app
paginates client-side.

---

## Frontend pattern — schema registry + STATE + render loop

Every page that uses the redtable follows the same three-part shape.
[Objects](../redpash-components-pages/objects-page/index.md) is the
canonical implementation; the others are subsets.

### 1. The schema registry

A `SCHEMAS` object keyed by row "kind". Each entry describes:

```js
{
  label, title, icon,                       // tab strip metadata
  fetch:      () => api.get("/files"),       // returns { items: Row[] }
  columns:    [ { key, label, render, hidden?, edit? }, … ],
  rowHref:    (r) => "#/cleaner?file=…",     // row → URL (no rowHref → row isn't clickable)
  canDelete:  true,                          // tab-level
  canDeleteRow: (r) => !r.is_default,        // optional per-row gate (projects use this)
  deleteOne:  (rid) => api.delete(…),
  saveEdit:   (rid, field, value) => api.patch(…, { [field]: value }),
  openEditor: (rid) => {…},                  // for edit:open type
  addHref:    "#/reports?new=1",             // for the "+" button
}
```

The `edit` spec on a column is what makes a cell editable. Five types,
all defined in the [Objects-page edit-cell section](../redpash-components-pages/objects-page/index.md):

| `edit.type` | What it swaps the cell for |
|---|---|
| `text` | `<input>` — Enter / Tab / blur commits. Pre-fill reads `row[field]` (not `td.textContent`) so badge-rendered cells like a `null` Encoding don't pre-fill `"null"`. |
| `bool` | Yes/No `<select>`. |
| `enum` | `<select>` of fixed `[value, label]` options. Used for projects' Status, files' Delimiter (Comma/Semicolon/Tab/Pipe). |
| `select` | Async entity picker — `edit.source` selects the list (`"users"` for owner reassignment, `"projects"` for moving a file). |
| `open` | Hands off to `schema.openEditor(rid)` — reports / dashboards Title columns open the builder. |

### 2. STATE

A `STATE` object keyed by kind. Each entry holds the per-tab live config:

```js
{
  rows, filtered,                            // last fetch + filtered slice
  search, page, rowsPerPage,
  mode,                                      // null | "edit" | "select" | "delete"
  selected,                                  // Set of redpash_ids
  colOrder, visibleCols,                     // populated by _ensureColState from saved view or schema defaults
  showRowNums, dateFmt,                      // toolbar prefs
  // …filter predicates, favorites, etc.
}
```

`_ensureColState(kind)` lazily seeds `colOrder` / `visibleCols` from
`prefs.objects_views[kind]` if present, otherwise from the schema's
declared order + non-`hidden` cols. The reconciliation also handles
**columns added to the schema after the view was saved** — they're
appended to `colOrder` and (if non-`hidden`) seeded into `visibleCols`,
so a new default column (files' **Stage** column, for instance) flows
into existing saved views instead of staying hidden until the user
notices.

### 3. The render loop

```
loadTable(kind)
  → schema.fetch()           — pull rows
  → renderTable(kind)        — paint header + body
       → _visibleOrderedCols(kind)  — derive paint order from STATE
       → _ensureColState(kind)      — populate STATE if first paint
       → emit <thead> + <tbody> via column .render() functions
       → wire row-click navigation (rowHref) + per-row delete buttons
```

Each row emits as a `<tr data-rt-row-open="<rid>">` plus a leading
`select` checkbox `<td data-mode-col="select">` and trailing `delete`
trash `<td data-mode-col="delete">`. The `data-mode-col` attributes are
permanently in the DOM; the library's CSS shows/hides them based on
which `rp-rt-mode-*` class is on the panel, so toggling a mode is
free — no body re-render.

Beyond the two mode-columns, the row also carries a permanently-visible
trailing **`.obj-row-open-cell`** with one or more icon links — the
Objects-page open-in-cleaner / open-in-report / open-in-dashboard
buttons (stage-driven via `_objRowOpenButtons`). Row click no longer
navigates anywhere; the navigation intent is explicit, in this cell.

---

## Column sort — chained, shift-click extends

Every `<th>` is a sort target, and the sort is a **chain**
(`sorts: [{ col, dir }, …]`, primary first) so any column can serve
as a tie-breaker for any other. Mirrors the Rust `PageQuery.sorts`
JSON shape so the cleaner can hand its chain straight through.

- **Plain click** replaces the whole chain with `[{col, asc}]`; if
  the column is already the sole key, flips its `dir`.
- **Shift-click** appends at `asc`, or flips `dir` if already in the
  chain. **Alt+shift-click** removes it.

The library ships `.rp-rt-sort-th` + `.rp-rt-sort-ico` styles for the
active-column colour bump and the fade-→-active arrow. The app adds a
`.rp-rt-sort-rank` accent pill on each active header when the chain
has more than one key, so primary / tie-breakers are distinguishable
at a glance.

Per page:

- **Objects** — client-side. `STATE[kind].sorts` applied right after
  the filter step in `renderTable`; comparator walks the chain and
  returns the first non-zero result. Uses `_objColValue` so it covers
  render-only keys. Saved view serialises the chain as
  `sorts: [{col, dir}, …]`; legacy single-key `sort` is migrated.
- **Cleaner** — server-side. `STATE.sorts` is sent as
  `GET /api/files/:rid/page?sorts=<json>`; PageQuery prefers the JSON
  chain over the legacy single `sort/dir` pair. In-memory state
  resets on every file switch. The header is also `draggable` for
  column reorder — `dragend` fires instead of click after a real
  drag, so sort + drag don't collide.

## Resizable columns

Every `<th>` carries a stable `data-rt-col="<key>"` plus a 6 px
`.rp-rt-col-resize` grip on its right edge. `_objInitColResize` wires
`pointerdown` → `pointermove` → `pointerup` on the grip, writes the
new width into `STATE[kind].colWidths[key]`, and replays it on every
subsequent `renderTable`. Data cells render with `text-overflow:
ellipsis; overflow: hidden` so a narrowed column truncates rather than
reflowing the row.

The widths are per-tab in-memory only — they don't ride
`prefs.objects_views` (yet) and don't survive a reload. The grip lives
on `<th>` for every column (not just user-flagged ones) so the
behaviour is uniform; resize is the user's primary tool for taming a
column whose values are longer than the column header.

---

## Star toggle — favorites in-row

For schemas where the row carries `is_favorite` (reports, dashboards),
the `Fav` column renders as a star icon button via `_objStarBtn(rid,
field, on)` rather than a regular value. Click runs `objToggleStar`:
optimistic flip → `PATCH /api/{reports,dashboards}/:rid` with the new
boolean → rollback on error. This is the one toggle that wanted a
one-click affordance instead of going through the Edit-mode dblclick
→ select → commit path.

---

## Mode classes — edit / select / delete

Three mutually-exclusive inline modes, controlled by an **icon-button
triplet** in the toolbar (`<button class="rp-rt-icon-btn"
data-rt-mode="edit | select | delete" aria-pressed="…">`). The handler
(`objToggleMode` / `rtToggleMode` — same shape on every page) walks
`.rp-rt-icon-btn[data-rt-mode]` siblings to clear the others, flips
`.is-active` + `aria-pressed` on the clicked one, then sets the
`rp-rt-mode-*` class on the panel. Was a `<label class="rp-rt-switch">`
toggle before the consolidation — switches are still in the library
for `redpash-demo`'s use, just no longer emitted by the app.

| Mode | Effect |
|---|---|
| `rp-rt-mode-edit` | Editable cells (those with a schema `edit` spec) get a dashed hover cue. Dblclick → `objCellEdit(td)` swaps the cell. The library CSS surfaces the cue; the app owns the cell-swap. |
| `rp-rt-mode-select` | Leading checkbox column unhidden. Ticking rows updates `STATE[kind].selected`; the toolbar selection chip + bulk-delete button activate. |
| `rp-rt-mode-delete` | Trailing trash column unhidden. Per-row trash → `objRowDelete(rid)`. Disabled for rows where `schema.canDeleteRow(row) === false` (projects' default-project guard). |

Mode state is per-kind on the Objects page (each tab remembers its
mode); per-file on the cleaner (each file tab keeps its own).
Switching tabs always clears the modes — `objActivateTab` does
`panel.classList.remove("rp-rt-mode-*")`.

---

## Saved views

Per-tab view config persisted to `prefs.objects_views` (the user
prefs JSONB on `users.prefs`). On the Objects page this stores
`colOrder` + `visibleCols` + `rowsPerPage` + `showRowNums` + `dateFmt`
per kind; the predicate filter panel is **deliberately excluded** (the
filter panel has its own save button — folding the two together would
be a confusing second control for the same thing).

The Save button flashes with a `~0.9s` accent pulse on every captured
toolbar control via `_objFlashSaved()` — Columns, Column-order,
Rows-per-page, Date-format, and the row-numbers toggle — so the click
shows the user *what* got persisted, not just a toast.

---

## Semantic dtype + cast suggestion (cleaner-specific)

The cleaner's Data Types sidebar (`#cleaner-dtype-list`,
[`_renderDtypeList`](../../../frontend/scripts/pages/cleaner.js)) reads
two fields off each `ColumnMeta` — `dtype` (storage, what Polars
parsed) and `semantic_dtype` (intent, sniffed by
[`data::dtype::sniff_semantic_type`](../../../backend/crates/data/src/dtype.rs)).
When they disagree on a string-stored column, the row renders a
*"storage → semantic"* suggestion with **confirm / dismiss** buttons:

- **Confirm** → `POST /api/files/:rid/cast-preview` first, opens a
  styled modal showing the would-null count + samples, then on user
  approval dispatches the real `cast` step. The plain `window.confirm()`
  shortcut was removed after the user hit a silent-null incident — a
  date column with `"2023"` (year-only) value was nulled without warning.
- **Dismiss** → saves `(rid, col)` to a per-file `localStorage` skip
  set so the suggestion stops appearing for that column; a ↻ revert
  control reopens it.

Casts that succeed update the storage dtype; the next refresh removes
the suggestion. The cleanness score's *type-consistency* component
still flags genuine dirt the cast can't handle (`€995.83`, `1234,56`)
so the user knows to apply a `replace_text` step first.

---

## Wired vs stubbed per page

| Page | Data source | Mutations | Library chrome | Custom chrome |
|---|---|---|---|---|
| **Objects** | `GET /api/{kind}` per tab (reports / dashboards LEFT JOIN owner; companies LEFT JOIN my_role; users + memberships) | `PATCH/DELETE /api/{kind}/:rid` per row (companies/users dev-permissive), `POST /api/{companies,users}` via `addAction`, `POST/DELETE /api/files/:rid/cleanness` for Score / Clear-scores, `PATCH /api/me` for prefs | base redtable + resizable columns + star toggle + trailing open-buttons cell | Customizable tab strip, upload modal, Save view glow, Score / Clear-scores toolbar |
| **Cleaner** | `GET /api/files/:rid/page` (server-paginated) | `POST /api/files/:rid/steps` per cleaning step, `POST /api/files/:rid/{undo,redo,cleanness,snapshot,encoding}`, `POST /api/files/:rid/joins`, `DELETE /api/files/:rid` | redtable pro (tabs + tools panel + Data Types + Join Preparation) | 17 tool modals, cleanness bar, history undo/redo |
| **Reports list** | `GET /api/reports` (flat) | `POST /api/reports`, `PATCH /api/reports/:rid`, `DELETE /api/reports/:rid` (via Objects' Reports tab today) | base redtable (Objects-style) | Builder is a separate non-redtable view |
| **Dashboards list** | `GET /api/dashboards` (flat) | `POST /api/dashboards`, `PATCH /api/dashboards/:rid`, `DELETE /api/dashboards/:rid` (via Objects' Dashboards tab today) | base redtable (Objects-style) | Builder is a separate non-redtable view |

The report-builder and dashboard-builder **modes of Workspace** don't
use the redtable at all — their data model is a pre-aggregated report
spec, not a raw row table, so they paint a custom preview pane instead.
See [`features/reports.md`](../../features/reports.md) and
[`features/dashboards.md`](../../features/dashboards.md).

---

## Cache / refresh

Every change to a page partial, the page's JS, or any imported library
component triggers a `service-worker.js` `CACHE_VERSION` bump.
Unregister the SW + hard-refresh (Ctrl+Shift+R) to see edits — or open
the page in Firefox private (the dev server's `ServeDir` sends no
`Cache-Control` headers, so Chrome heuristic-caches JS aggressively).

---

## Related

- [`objects-page/index.md`](../redpash-components-pages/objects-page/index.md) — the canonical schema-driven implementation.
- [`features/cleaner.md`](../../features/cleaner.md) — Workspace's cleaner mode, the redtable-pro variant with per-file tabs + tools panel.
- [`features/cleanness.md`](../../features/cleanness.md) — the score that lives in the cleaner's header chrome + drives the cast-suggestion loop.
- [`api/files.md`](../../api/files.md) — `GET /api/files/:rid/page` + `PageQuery` contract.
- [`objects/file.md`](../../objects/file.md) — `ColumnMeta` (incl. `semantic_dtype`) + `FileSummary` DTOs.
- Library: [`03-data-table.md`](/home/mansa/redpash-components/03-data-table.md), [`07-redtable-schemas.md`](/home/mansa/redpash-components/07-redtable-schemas.md), [`08-cleaner-workspace.md`](/home/mansa/redpash-components/08-cleaner-workspace.md).
