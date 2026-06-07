---
title: frontend/scripts/pages/dashboard.js
source: ../../../../../frontend/scripts/pages/dashboard.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-07
---

# dashboard.js

## Purpose

The **standalone chart + dashboard designer** page (`#/dashboard`, Studio app — Slice D
of the multi-app split). Carved out of the Workspace page's in-page Data↔Dashboards
rail-toggle: this page owns the **designer surface only**. Its rail lists each project's
**charts + dashboards** (`file_type` chart/dashboard); the data SOURCE for new charts is a
**project-wide CSV picker** (`#dashSourceDd`) — ANY project CSV, **including SheetWise
materialized results + connector pulls** (they're plain `file_type='csv'` rows) — not a
single active Workspace file. The split also deletes the Workspace view-switch re-entrancy
bug (runbook CAS_3BCD6727): with no opposite surface to toggle to, there's no echo to guard.

## Public surface

- `export default function dashboard(app, { session })` — the page mount (main.js `/dashboard`).
- `mountTopbar(el, { active: "dashboard", session })` — the per-app topbar derives the **Studio**
  app from `active` via [apps.js](../framework/apps.md) `appForPage` (Slice A); the Studio nav
  lights up automatically. The "Dashboard" nav entry is one line in `apps.js` `studio.pages`.
- **designer.js is mounted UNCHANGED** — it's already ctx-polymorphic. The page supplies the ctx:
  `getSource()` = the **picked** project CSV; `getSourceFiles()` = **all** project CSVs (the
  per-tile source dropdown); `onSaved` / `onDashboardSaveUnavailable`. Each chart tile carries its
  own `source_file_id`, so a multi-tile dashboard mixes sources freely.
- Rail: the framework **`mountRail`** component (D0', 2026-06-07 — same component as
  admin-console/sheetwise/database). The page holds a groups data-model
  (`cachedProjects` + `filesByGroup` + `expanded`) and re-renders via
  `rail.setGroups(buildGroups())`; `mountRail` owns the markup, collapse, search/chips
  wiring, and the **New dashboard** footer. Handlers: `on.tab`→`loadFile`,
  `on.groupToggle`→lazy-load + `refreshSources`, `on.create`→`createDashboard`. **Add
  chart** (designer toolbar) promotes a standalone chart to a real dashboard, then
  appends a widget from the picked source.
- Open paths: a chart (`CHT_*`) loads wrapped as a synthetic 1-widget dashboard (`chartAsDashboard`);
  a dashboard loads its multi-tile spec. Both via `/api/charts/:rid` / `/api/dashboards/:rid`.
- **`?source=<FIL_rid>` deep-link (D2 bridge).** The Workspace per-row "Visualize" glyph navigates
  to `#/dashboard?source=<csv-rid>`. On init this page parses the source rid out of `location.hash`
  (the router strips the `?` suffix before matching — `main.js:69`), fetches the file to resolve its
  project, focuses that project's rail group, and pre-picks the CSV as the chart source (`setSource`).
  Best-effort — an unknown / non-data rid falls back to the default first-CSV pick.

## Drift-prone areas

- **D0' adopted `mountRail`, not a new `project-rail.js`.** The map (2026-06-07) found
  `framework/rail.js` already IS the canonical rail (admin/sheetwise/database use it), so
  a 3rd module would have been parallel-class debt. This page composes `mountRail`; the
  rail markup is no longer hand-built here. The **groups data-model** is the contract: a
  re-render is `rail.setGroups(buildGroups())`, never DOM surgery. `mountRail` re-renders
  the whole body on `setGroups`, so expanded state lives in the `expanded` Set (synced in
  `on.groupToggle`) and loaded files in `filesByGroup` — both feed `buildGroups`.
- **Source = a project CSV, not the active file.** The picker sets `sourceCache` (`getSource`);
  `refreshSources(projRid)` rebuilds the project CSV list + defaults to its first CSV. SheetWise /
  connector outputs need **no special-casing** — they're `file_type='csv'`.
- `data-dd` open/close is the global `bindDropdown` (main.js); don't re-bind per page.
- Class family is `rp-dash-*` / `rp-rail-*` (guarded by `tools/retired-class-audit`).

## Related

- [pages/workspace.md](workspace.md) — the page this split from (now data-redtable only after D2).
- [designer.md](../designer.md) + [charts/builder-ui.md](../charts/builder-ui.md) — the unchanged, ctx-polymorphic designer.
- [framework/apps.md](../framework/apps.md) — the per-app registry the `#/dashboard` nav entry plugs into.
- Plan: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` (Slice D); multi-app plan `yes-assess-current-situation-cozy-flame.md`.
