---
title: frontend/scripts/pages/workspace.js
source: ../../../../../frontend/scripts/pages/workspace.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-07
---

<!-- 2026-06-07 (Slice D / D2): the Dashboards path was STRIPPED from Workspace.
     The designer mount, the Data↔Dashboards rail-view seg (#wsRailView), the
     designer-mode surface swap, and every chart/dashboard create + open flow are
     gone (~515 lines deleted). Workspace is now a pure data-redtable; charting
     lives on the standalone #/dashboard page (pages/dashboard.js). This DELETED
     the CAS_3BCD6727 view-switch re-entrancy bug outright. The rail-foot button is
     now New Project; each data-file row carries a per-row "Visualize" chart glyph
     (.rp-rail-tab-visualize) that deep-links the CSV to #/dashboard?source=<rid>.
     A chart/dashboard rid reaching loadFile (only via an external deep-link, since
     the rail filters them out) redirects to #/dashboard. Runbook 0019.
     Sections below marked [D2-REMOVED] describe machinery that no longer exists. -->

<!-- 2026-06-07 (Slice D / D0'): the projects→files RAIL was migrated off its
     hand-built markup onto the framework `mountRail` component (frontend/scripts/
     framework/rail.js) — the same rail admin-console/sheetwise/database/dashboard
     use. Workspace no longer emits any rp-rail-* markup or wires collapse/search/
     chips/rename/hide itself: it owns a groups DATA-MODEL (cachedProjects +
     filesByGroup + expanded + uploadGhosts + the hidden prefs) and a re-render is
     refreshRail() = rail.setGroups(buildGroups(), buildHidden()). The on{} handlers
     (tab/groupToggle/groupRename/groupHide/tabRename/tabHide/restore/create + the
     custom `visualize`) carry the page logic. Deleted: renderRail/projectGroup/
     renderFiles/fileTab/syncGroupCount/applyRailFilters/landingTabHTML/the navBody
     delegator/enterProjectRename/enterFileRename/focusedProjectGroup/the upload
     ghost-DOM helpers. The descriptions of those below are HISTORICAL. -->


# workspace.js

## Purpose

Workspace page — the redtable as a browser, wired to /api. On mount: load real projects + lazy-load files per group. File click fetches columns + page and renders. Toolbar (search, sort, select / edit / delete, columns, filter builder) operates on the loaded page. Data files only — charts + dashboards are filtered out of the rail (`renderFiles`) and live on `#/dashboard` (Slice D / D2).

## Public surface

- Default export: page mount.
- Mounts Tools panel + Filter panel + Report builder eagerly.
- Joins tab eager-mounted (2026-05-29).
- Rail = the framework `mountRail` component (D0'); the page is a config-supplier + groups data-model (`buildGroups`/`buildHidden`/`refreshRail`). Per-row "Visualize" glyph (mountRail `actions` → `on.visualize`) deep-links a CSV to `#/dashboard?source=<rid>`; rail-foot "New Project" (`footer.create` → `on.create` → `newProject`).
- **Rail search is file-aware** (2026-06-07): `buildGroups` matches the query against project names AND data-file names — a file-only match shows that group expanded with just the matching files; `search.onInput` calls `ensureAllFilesLoaded()` so files in not-yet-expanded groups also match (global). The data-only filter (`f.file_type !== "chart"/"dashboard"`), hidden-file filter, ghost-upload tabs, and per-row Visualize actions are all preserved across the search path.

## Drift-prone areas

- **Design-language rollout — RAIL + TOOLBAR + PANEL slices migrated (2026-06-05); table/designer
  PENDING.** PANEL slice (CAS_B747F2B6): the filter/history/tools panels + report-builder + joins
  migrated `rt-*`→`rp-*` across workspace.js/tools.js/joins.js/report.js/autocomplete.js/tools/fields.js
  + partials/workspace.html + panel.css. The generic panel chrome (`rp-panel*`, `rp-pred*`, `rp-seg`,
  `rp-tool-columns*`, `rp-step-preview*`, `rp-menu*`) now resolves to the framework atoms
  (`framework/{panel,filter-panel,seg,tools-panel,menu}.css`); panel.css keeps only the
  workspace-unique survivors (step-history, report-builder, joins, sentinels, tool-status, the
  predicate measure/inline overrides). 134 byte-equivalent framework dups were pruned from panel.css
  (`tools/css-twin-verify`). `rt-step-state` became a real `rp-step-state` atom (atoms.css, a modifier
  composing `rp-empty`). **Cascade note:** the measure-row overrides compound `.rp-pred.rp-report-measure`
  (specificity 0,0,2,1) to beat the framework's now-unguarded `.rp-pred > .rp-pred-col`. The shared
  `dropdown.js` close-selector was extended to `.rt-dd.open, .rp-menu.open` (the report/multi-picker
  dropdowns are `rp-menu` now). Toolbar (data): `rt-toolbar--data`→`rp-toolbar--data`, `rt-toolbar-sep`→`rp-toolbar-sep`,
  `rt-mode`→`rp-toolbar-mode`, `rt-pill`→`rp-chip rp-toolbar-pill` (+`.chev`→`rp-toolbar-chev`),
  `rt-dd*`→`rp-menu*` (+`.tick`→`rp-menu-tick`), `rt-sel-chip`→`rp-chip rp-toolbar-selchip`, and
  `rt-btn`→`rp-btn-icon` migrated **page-wide** (clean atom swap — no `.rt-toolbar .rt-btn` context
  rule). The **designer** toolbar stays `rt-toolbar--designer` (its slice → `rp-dash-toolbar`). The rail (projects→files tree) is JS-rendered with the full framework
  family — `rp-rail`/`-head`/`-title`/`-body`/`-state`/`-footer`, `rp-rail-group*` (incl. `-hide`/
  `-rename`/`-name-editing`), `rp-rail-tab*` (incl. `-dot`/`-ghost*`/`-rename`/`-spinner`; close→
  **`rp-rail-tab-hide`**), `rp-rail-overview` (the pinned entry), `rp-rail-filter`/`-chips`,
  `rp-search`. (The `rp-rail-views` Data/Dashboards seg track was **removed in D2** — see top note.)
  Markup + the render/drag/hide/rename JS move in lockstep. The shared rail helpers (`rail-controls.js`
  `mountRailCollapse`/`mountRailSeg`, `rail-footer.js`) are **ref/`[data-rail-seg]`-attribute based** —
  they didn't need changing. **Still `rt-*` (later slices):** the **redtable** (`rt-table*` → slice 4,
  `rp-redtable`, the highest-risk core grid), the **designer** surface + its toolbar (`rt-designer`,
  `rt-toolbar--designer`/`-spacer` → slice 5, `rp-dash-*`), the virtual-rows spacer (`rt-vrow-spacer`),
  the hide-restore UI (`rt-hidden*`), and a generic spinner state (`rt-spinning`). These were held
  back verbatim by the panel-slice rename's `--leave=table,designer,toolbar,vrow,hidden,spinning`.

- **Rail-foot button = New Project (Slice D / D2, 2026-06-07).** With charting moved
  to `#/dashboard`, the old context-aware `#wsCreate` create button (CAS_37B2E1BF: Data→New
  chart / Dashboards→New dashboard, driven by `WS_CREATE`/`syncWsCreateButton`/`railViewSeg`)
  is **removed**. The rail-foot button is now `#wsNewProject` (glass CTA) — Em's "New chart
  button in the rail-foot becomes New Project"; the rail-**head** plus-button was dropped so
  there's one New Project affordance. The existing new-project handler binds by id, so it
  moved unchanged. **Upload** stays in the data toolbar (`#wsUpload`) **and** the landing —
  both `.click()` the one hidden `#wsUploadInput`. **Visualize:** each data-file row gets a
  `.rp-rail-tab-visualize` glyph; the navBody delegator short-circuits its click to
  `location.hash = "#/dashboard?source=" + rid` (caught before the generic tab→loadFile
  branch, like the rename pencil), so dashboard.js pre-picks that CSV as the chart source.
- Composes virtually every other frontend module; the deepest single page.
- **Client engine — WASM sort over the loaded set (2026-06-01, Em "sorting should use WASM"):** a data file with `summary.row_count ≤ CLIENT_ENGINE_ROW_CAP` (500000) enters `clientMode`. `refreshClientBuffer()` pulls the WHOLE result set in one `/page` call (`size = cap+1`; server applies filter + search but **NO `sorts`** — sort is client-side now) and coerces every cell to its **storage** `dtype` (`coerceCell`, so the wasm engine sorts numerics numerically, matching the server) into `clientBuffer = {cells, idxs, typed}`. `clientRender()` then sorts `typed` via **`workerSort` (the wasm `apply_sort` run in `engine.worker.js`, OFF the main thread)** — stacked single-column sorts, least-significant key first, multi-key relies on a stable sort — and renders the **WHOLE buffer** (no page slice; `currentPage/totalPages` collapse to 1) through `createVirtualRows`, which windows the DOM (~40-50 `<tr>`, not N). So a ≤cap file shows **every row with smooth scroll, no pagination** ("everything loaded" — the 25-row page window was the regression) — **no server round-trip on a sort/scroll gesture**. (Productionized 2026-06-01, CAS_21B43BEC: stringify + `apply_sort` + parse all run in the worker and only the `__p` permutation crosses back, so the ~0.8 s/40k main-thread freeze is gone — spike measured 400 ms→17 ms max frame gap. Two-level fallback: `workerSort` fails → main-thread `getEngine()` sort → buffer order, so a sort gesture never blanks the grid; `warmWorkerEngine()` on mount compiles the wasm in the worker.) The cap MUST stay ≤ the server's page-`size` clamp (also 500000) or the buffer truncates silently. Filter/search still hit the server (the wasm `apply_filter` is the FLAT `filter_rows` step, not the nested query `FilterNode`, and there's no search wrapper) → they call `refetchPage()` which in `clientMode` calls `refreshClientBuffer()`. Over the cap, everything stays on the server page path (`fetchAndRender`). Engine failure in `clientRender` falls back to buffer order (never blanks the grid). **Completeness guard (correctness):** `refreshClientBuffer` only keeps `clientMode` if the fetched rows are the WHOLE result set (`total <= cells.length`); if the server clamped the fetch below `total` (i.e. the cap were ever set above the `/page` size clamp), it drops to server-mode rather than client-sort a TRUNCATED buffer (which would silently produce a wrong global sort). So a partial sort is impossible regardless of how `CLIENT_ENGINE_ROW_CAP` relates to the server clamp. Moving filter/search client-side needs new wasm wrappers + a bundle rebuild — see [wasm-engine](../../../../subsystems/wasm-engine.md).
- **Tools-step header refresh (2026-06-01):** the Tools-panel `onApplied(res)` (the `mountTools` callback) re-runs `loadFile(rid)` after a step, and `loadFile` reads `fileEnvelopeCache`. It now seeds that cache with the `/steps` response (`res` — the rebuilt envelope) BEFORE the reload, mirroring `applyStep`. Without it, a column-changing step (snake_case_columns, replace_in_names, split_column, drop_columns) applied + persisted server-side but `loadFile` read the stale pre-step envelope, so the main-table headers stayed on the old names. (Undo/redo never had this bug — `doUndoRedo` updates `activeColumns` + the cache directly.)
- **Lazy-load gate clears on collapse→expand (2026-06-01):** `loadFilesForGroup` short-circuits when `group.dataset.filesLoaded === "1"`. The expand handler at the click delegator (around line 1075) now clears that gate on every collapse→expand toggle so external file writes (Kafka loader, scheduled jobs, anything that lands a `project_files` row outside the UI's upload/create flows) become visible without a full page reload. Cost: one extra API round-trip per re-expand. Trigger context: the Kafka loader landed `FIL_E9F50710BC6B439A92738BB17B7D83E8` into a project whose group was already expanded; the file showed in Home (`/api/files`, no per-group cache) but not in Workspace until a refresh. The cache invalidation makes Workspace pick it up on the next collapse→expand. (The old `workspaceRailView` pref + `data-view-kind` CSS-hide note is moot post-D2: the rail shows data files only via `renderFiles`, with no view toggle.)
- **[D2-REMOVED] Rail view-switch surface swap (CAS_3BCD6727).** The entire "Data ↔
  Dashboards" toggle machinery — `#wsRailView` seg, `lastFileRidByView`, `railSyncing`,
  `setRailView`, `maybeAutoToggleRail`, `currentSurfaceView`, and the `is-designer-mode`
  surface swap — was **deleted in Slice D / D2** along with the in-page designer. There is
  no opposite-view surface to toggle to, so the re-entrancy bug the swap guarded against can
  no longer occur (the page split is the structural fix). `showLanding()` now toggles only
  `is-landing-mode`; `loadFile` opens a CSV in the redtable and redirects a chart/dashboard
  rid to `#/dashboard`. See [runbook 0019](../../../../runbooks/0019-workspace-dashboards-strip.md)
  (supersedes the old CAS_3BCD6727 runbook).

## Related

- [Frontend pillar landing](../../../index.md)
