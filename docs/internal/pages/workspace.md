---
title: Page — Workspace
section: Internal
last modified date: 2026-06-07
---

# Page — Workspace

The Workspace is RedPash's **data surface** — the redtable as a browser,
wired live to `/api`. It is where a user opens a project's files, scrolls
the rows, cleans + transforms them, builds reports, and designs charts +
dashboards. Everything on this page is real server data; nothing is mock.
The page module is `frontend/scripts/pages/workspace.js` (mounted by the
router with `(app, { session })`).

## The shape of the page

Three regions, left to right:

- **Rail** (left) — the project/file navigator. Project groups expand to
  reveal their files; the rail head carries a **Data ↔ Dashboards
  rail-seg** (a `mountRailSeg`, NOT page tabs — see below), a project-name
  search box, and ownership pills (All / Personal / Shared / Company). A
  pinned **Overview** entry at the top returns to the landing surface. The
  rail foot has one context-aware **create** button plus **+ New project**.
- **Main surface** (`#wsSurface`) — has three mutually exclusive *modes*
  driven by CSS classes on `#wsSurface`, which is the single source of
  truth for "what view am I in" (`currentSurfaceView` derives the view
  kind from these classes rather than a parallel variable that could
  drift):
  - **landing** (`.is-landing-mode`) — the default overview when no file
    is open: a hero strip (by-stage donut + avg-cleanness gauge + a 2×2
    stats grid), a recent-projects card grid, and a flex-filling projects
    table. The Workspace twin of the Cases board.
  - **data** — the RedTable plus its toolbar, left filter/report panel,
    and right clean/joins + history panels.
  - **designer** (`.is-designer-mode`) — the chart/dashboard canvas.
- The **left panel** (filter/report) and the **right panels** (history,
  tools=clean/joins) slide in over the data surface.

## Rail: Data ↔ Dashboards is a *view filter*, not tabs

The rail-seg never refetches. Every project group already renders **all**
its file kinds on expand; the seg sets `nav.dataset.railView` and CSS
hides the rows whose `data-view-kind` doesn't match (`data` files vs
`report`/`dashboard` rows). Toggling the seg also swaps the main surface
to that view's **last-opened file** (`lastFileRidByView`, one slot per
view) — or drops to the landing if that view has nothing to restore, so a
wrong-kind file never lingers under the new view. `loadFile` mirrors the
seg back to the opened file's kind via `maybeAutoToggleRail`; that echo is
guarded by `railSyncing` so it doesn't bounce into a second surface swap
(CAS_3BCD6727).

## Rail: projects, files, focus, hide/restore

`loadProjects` fetches `GET /api/projects` and renders groups; files load
lazily per group via `GET /api/projects/:rid/files` on first expand
(`loadFilesForGroup`), and the collapse→expand gate is cleared every time
so externally-written files — Kafka loader, scheduled jobs, anything
outside the UI's create flows — become visible without a reload.

After a group's files render, `prewarmGroupFiles` background-fetches each
non-chart file's `GET /api/files/:rid` envelope (idle-time) into
`fileEnvelopeCache`, so the typical tab click is a cache hit and renders
instantly. Charts (`CHT_` prefix) skip the prewarm — they go through
`/api/charts`, a different shape, and `/api/files/:rid` 500s on chart rids.

**focusedProjectRid** tracks which project the user is on, *independent*
of whether a file is open. It updates on group-head click, on file open
(inherits the file's project), and on the deep-link expand. The rail-foot
buttons (upload / create / new project) all resolve their target through
it, so they hit the *visible* project even when the user only clicked a
group head.

Hide/restore is pure declutter persisted in `user_preferences`
(`rail_hidden_projects` / `rail_hidden_files`); a `Hidden (N)` recovery
`<details>` at the rail tail restores entries. Hiding never cuts the data
source or gates view-access — stats on the landing still span *all*
projects. Project and file rail entries both rename inline (contenteditable
+ `PATCH /api/projects/:rid {name}` / `PATCH /api/files/:rid {display_name}`).

Deep links: `#/workspace?project=<rid>&file=<rid>` auto-opens into the
surface (Home uses this to land a user on a specific chart/csv); a **bare**
`#/workspace` expands the default project's rail for context but shows the
landing — the auto-open is gated on `data-autoopen`, set only for deep
links.

## Opening a file: one dispatcher, three load paths

`loadFile(rid)` resets all per-file state (sort keys, filter, search,
client buffer, page) then branches on the rid prefix / `file_type`:

- **`CHT_` chart** → `GET /api/charts/:rid`, enter designer mode, render
  it wrapped as a synthetic 1-widget dashboard (the dashboard canvas is
  the one view where "Add chart" appends rather than replaces — Em
  2026-05-28). The synthetic wrapper has `redpash_id: null` so the
  designer + Add-chart handler skip the dashboard-PUT path.
- **`dashboard` file** → `GET /api/dashboards/:rid`, designer multi-tile
  canvas (each widget references a chart by id; the designer fetches them
  in parallel).
- **data (CSV) file** → cache-first envelope (`{ summary, columns, steps }`),
  rebuild the columns dropdown + filter columns, refresh the Tools/Joins/
  Report panels (data-only — firing them for a chart/dashboard rid would
  400 against the server's `not_a_data_file` guard), then render the grid.

## The RedTable: client engine vs server page

The grid is windowed by `createVirtualRows` (~40 `<tr>` mounted regardless
of row count) and has two data paths, **gated by capacity, not
capability**:

- **client mode** (file ≤ `CLIENT_ENGINE_ROW_CAP` = 500 000 rows): the
  whole server-filtered+searched result set is buffered once
  (`refreshClientBuffer` — one `/page` fetch sized to the cap+1), coerced
  to typed values, and **sort + paging run client-side over the buffer**
  via the wasm engine off the main thread (`workerSort`) — instant, no
  round-trip, the user scrolls the *entire* file (no page slice). A
  **completeness guard** drops to server mode if the server clamped the
  fetch below the full result-set size, so a partial buffer can never
  produce a wrong global sort.
- **server mode** (over the cap): every gesture rides
  `GET /api/files/:rid/page?page=&size=&q=&sorts=&filters=` and the pager
  walks server pages.

Note: **filter + search always hit the server** in both modes (the wasm
wrappers cover flat sort, not the nested `FilterNode` query or search — a
follow-up). This honours the JS↔Rust boundary: JS owns pixels, Rust owns
the data engine; the page-local `passFilter`/`applySort`/`passSearch`
helpers were deleted when filter/sort/search moved onto the `Page<T>` wire.

## Toolbar (data mode)

Left-to-right the toolbar carries:

- **Search** (`#wsRowSearch`) — debounced, server-side via `PageQuery.q`.
- **Edit / Select / Delete** modes — mutually exclusive classes on the
  table. Cell edits (snapshot-on-focus, diff-on-blur) and row deletes both
  POST `set_cell` / `drop_rows` steps; delete-mode row click drops one row,
  Select+Delete drops the selected set. Selection lives in `selectedRows`
  (absolute frame indices), never on the DOM, because the virtualizer
  recycles rows. `"—"` is both the null placeholder *and* the empty signal
  back to the server.
- **Undo / Redo** — `POST /api/files/:rid/undo|redo`; enable state derives
  from `activeSteps[].applied`.
- **Refresh** — drops the rail's group-loaded markers + re-runs `loadFile`
  on the open file to pick up server-side changes.
- **Rows-per-page** + **Columns** dropdowns, **Export** (CSV/… via a hidden
  `<a download>` straight to `/api/files/:rid/export`; bypasses `api.js`
  because the body is a binary stream), and **row-numbers** toggle. All
  persist through `prefs.js`.

Every mutating gesture (`applyStep`, undo/redo, a Tools step) is
single-flighted via `stepInFlight`, refreshes the cached envelope, and
invalidates the column-index distinct-value cache for the file.

## Left panel — Filter + Report

A two-tab panel (`#wsFilterPanel`). **Filter** is a group/predicate
builder: `OP_SPECS` is the single source of truth for which ops a column's
dtype allows, how they group in the `<select>`, and which value control
renders (text / number / date / range / comma-list / none). The builder
walks the UI into a `FilterNode` tree (`shared::filter::FilterNode`) sent
as `?filters=`; single-value ops get autocomplete and `in`/`not_in` get a
chip-picker, both reading distinct values from the column-index subsystem.
**Report** edits a `ReportSpec` and previews subtotals via
`POST /api/group/preview`; the panel widens for the builder + sample table.

## Right panels — Tools (Clean / Joins) + History

A mutually-exclusive pair (opening one closes the other). **Tools** has two
eagerly-mounted tabs: **Clean** (the cleaning columns-redtable, a
parameterised factory of step configs) and **Joins** (sibling-file join
picker; auto-detection on each open is gated by `workspace-joinsAutoDetect`
since it's a POST per open). A join produces a new file and auto-opens it.
**History** renders `activeSteps` newest-first; applied steps render solid,
undone (redo-stack) steps dim.

## Designer (chart / dashboard mode)

`mountDesigner` runs the canvas; `enterDesignerMode` / `exitDesignerMode`
flip the surface class and hide the data-file panels. A standalone chart is
shown as a synthetic 1-widget dashboard; **Add chart** promotes it into a
real `POST /api/dashboards` (keeping the chart as the first widget) so the
button is never a dead no-op. The rail-foot create button is one
context-aware control (`WS_CREATE` / `syncWsCreateButton`): Data view →
**New chart** (charts the active data file), Dashboards view → **New
dashboard**. Saves go through `PUT /api/charts` / `PUT /api/dashboards`.

## Upload

`#wsUploadInput` → `doUpload` POSTs files **sequentially** (per-file
progress, no request burst) to `POST /api/files/upload` (multipart) into
the focused project's name (find-or-create), with ghost tabs shimmering in
the target rail group per outcome. After the batch it refreshes the rail
once, surfaces the Data view, and auto-opens the last successful upload.
The landing carries its own Upload CTA since the toolbar is hidden there.

## Source files

- [frontend/scripts/pages/workspace.js](../code/frontend/scripts/pages/workspace.md)
- [frontend/scripts/tools.js](../code/frontend/scripts/tools.md)
- [frontend/scripts/joins.js](../code/frontend/scripts/joins.md)
- [frontend/scripts/report.js](../code/frontend/scripts/report.md)
- [frontend/scripts/designer.js](../code/frontend/scripts/designer.md)
- [frontend/scripts/wasm-engine.js](../code/frontend/scripts/wasm-engine.md)
- [frontend/scripts/virtual-rows.js](../code/frontend/scripts/virtual-rows.md)
- [frontend/scripts/column-index.js](../code/frontend/scripts/column-index.md)
- [frontend/scripts/autocomplete.js](../code/frontend/scripts/autocomplete.md)
- [frontend/scripts/rail-controls.js](../code/frontend/scripts/rail-controls.md)
- [frontend/scripts/list-page.js](../code/frontend/scripts/list-page.md)
- [frontend/scripts/prefs.js](../code/frontend/scripts/prefs.md)
- [frontend/scripts/api.js](../code/frontend/scripts/api.md)
