---
title: frontend/scripts/pages/workspace.js
source: ../../../../../frontend/scripts/pages/workspace.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-01
---

# workspace.js

## Purpose

Workspace page — the redtable as a browser, wired to /api. On mount: load real projects + lazy-load files per group. File click fetches columns + page and renders. Toolbar (search, sort, select / edit / delete, columns, filter builder) operates on the loaded page.

## Public surface

- Default export: page mount.
- Mounts Tools panel + Filter panel + Report builder + Designer eagerly.
- Joins tab eager-mounted (2026-05-29).

## Drift-prone areas

- Composes virtually every other frontend module; the deepest single page.
- **Client engine — WASM sort over the loaded set (2026-06-01, Em "sorting should use WASM"):** a data file with `summary.row_count ≤ CLIENT_ENGINE_ROW_CAP` (50000) enters `clientMode`. `refreshClientBuffer()` pulls the WHOLE result set in one `/page` call (`size = cap+1`; server applies filter + search but **NO `sorts`** — sort is client-side now) and coerces every cell to its **storage** `dtype` (`coerceCell`, so the wasm engine sorts numerics numerically, matching the server) into `clientBuffer = {cells, idxs, typed}`. `clientRender()` then sorts `typed` via **`workerSort` (the wasm `apply_sort` run in `engine.worker.js`, OFF the main thread)** — stacked single-column sorts, least-significant key first, multi-key relies on a stable sort — and renders the **WHOLE buffer** (no page slice; `currentPage/totalPages` collapse to 1) through `createVirtualRows`, which windows the DOM (~40-50 `<tr>`, not N). So a ≤cap file shows **every row with smooth scroll, no pagination** ("everything loaded" — the 25-row page window was the regression) — **no server round-trip on a sort/scroll gesture**. (Productionized 2026-06-01, CAS_21B43BEC: stringify + `apply_sort` + parse all run in the worker and only the `__p` permutation crosses back, so the ~0.8 s/40k main-thread freeze is gone — spike measured 400 ms→17 ms max frame gap. Two-level fallback: `workerSort` fails → main-thread `getEngine()` sort → buffer order, so a sort gesture never blanks the grid; `warmWorkerEngine()` on mount compiles the wasm in the worker.) The cap MUST stay ≤ the server's page-`size` clamp (also 50000) or the buffer truncates silently. Filter/search still hit the server (the wasm `apply_filter` is the FLAT `filter_rows` step, not the nested query `FilterNode`, and there's no search wrapper) → they call `refetchPage()` which in `clientMode` calls `refreshClientBuffer()`. Over the cap, everything stays on the server page path (`fetchAndRender`). Engine failure in `clientRender` falls back to buffer order (never blanks the grid). **Completeness guard (correctness):** `refreshClientBuffer` only keeps `clientMode` if the fetched rows are the WHOLE result set (`total <= cells.length`); if the server clamped the fetch below `total` (i.e. the cap were ever set above the `/page` size clamp), it drops to server-mode rather than client-sort a TRUNCATED buffer (which would silently produce a wrong global sort). So a partial sort is impossible regardless of how `CLIENT_ENGINE_ROW_CAP` relates to the server clamp. Moving filter/search client-side needs new wasm wrappers + a bundle rebuild — see [wasm-engine](../../../../subsystems/wasm-engine.md).
- **Tools-step header refresh (2026-06-01):** the Tools-panel `onApplied(res)` (the `mountTools` callback) re-runs `loadFile(rid)` after a step, and `loadFile` reads `fileEnvelopeCache`. It now seeds that cache with the `/steps` response (`res` — the rebuilt envelope) BEFORE the reload, mirroring `applyStep`. Without it, a column-changing step (snake_case_columns, replace_in_names, split_column, drop_columns) applied + persisted server-side but `loadFile` read the stale pre-step envelope, so the main-table headers stayed on the old names. (Undo/redo never had this bug — `doUndoRedo` updates `activeColumns` + the cache directly.)
- **Lazy-load gate clears on collapse→expand (2026-06-01):** `loadFilesForGroup` short-circuits when `group.dataset.filesLoaded === "1"`. The expand handler at the click delegator (around line 1075) now clears that gate on every collapse→expand toggle so external file writes (Kafka loader, scheduled jobs, anything that lands a `project_files` row outside the UI's upload/create flows) become visible without a full page reload. Cost: one extra API round-trip per re-expand. Trigger context: the Kafka loader landed `FIL_E9F50710BC6B439A92738BB17B7D83E8` into a project whose group was already expanded; the file showed in Home (`/api/files`, no per-group cache) but not in Workspace until a refresh. The cache invalidation makes Workspace pick it up on the next collapse→expand. (Note: separately, the per-user `workspaceRailView` preference filters by `data-view-kind`; if it's stuck on `dashboards`, CSV rows are still CSS-hidden regardless of this fix — fix is "toggle to Data" or shipping #2 of suite #1B's auto-switch logic.)
- **Rail view-switch swaps the main surface (CAS_3BCD6727, fixed 2026-06-01):** The "Data ↔ Dashboards" rail toggle (`#wsRailView` / `data-rail-seg`) is more than a rail filter — toggling brings the corresponding view forward in `rp-surface`. Memory lives in `lastFileRidByView = { data, dashboards }`; the `loadFile` data branch, dashboard branch, **and both chart branches** each update their slot on successful render (a chart renders in the designer canvas, so it counts as a Dashboards-view file). The `onChange` handler:
  1. **Ignores the rail-sync echo.** `loadFile` mirrors the seg to the file it opened via `maybeAutoToggleRail → setRailView → set() → onChange` (rail-controls `set()` has no equality short-circuit, so it always fires). `setRailView` wraps that in a `railSyncing` flag; `onChange` returns early while it's set, so the echo never bounces back into a surface swap. A genuine user click on the seg goes straight to `set()` (bypassing `setRailView`), so `railSyncing` is false and the swap runs.
  2. **Derives the showing view from the DOM, not a parallel variable.** `currentSurfaceView()` reads the `#wsSurface` mode classes (`is-landing-mode` ⇒ null; `is-designer-mode` ⇒ `dashboards`; else a data redtable iff `activeFileRid` is set) — single source of truth, can't drift across the ~dozen `activeFileRid` reset sites. If it already equals the toggled-to view, no-op.
  3. **Otherwise the surface shows the OTHER view** (e.g. a CSV redtable while toggling to Dashboards). Restore `lastFileRidByView[view]` if remembered; **else clear `activeFileRid` and `showLanding()`** so a wrong-kind file never lingers under the new view. The pre-fix bug: this branch "left the surface as-is", so a CSV stayed visible after toggling to Dashboards.
  See [runbook CAS_3BCD6727](../../../../runbooks/CAS_3BCD6727-workspace-rail-view-surface-swap.md).

## Related

- [Frontend pillar landing](../../../index.md)
