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
- **Lazy-load gate clears on collapse→expand (2026-06-01):** `loadFilesForGroup` short-circuits when `group.dataset.filesLoaded === "1"`. The expand handler at the click delegator (around line 1075) now clears that gate on every collapse→expand toggle so external file writes (Kafka loader, scheduled jobs, anything that lands a `project_files` row outside the UI's upload/create flows) become visible without a full page reload. Cost: one extra API round-trip per re-expand. Trigger context: the Kafka loader landed `FIL_E9F50710BC6B439A92738BB17B7D83E8` into a project whose group was already expanded; the file showed in Home (`/api/files`, no per-group cache) but not in Workspace until a refresh. The cache invalidation makes Workspace pick it up on the next collapse→expand. (Note: separately, the per-user `workspaceRailView` preference filters by `data-view-kind`; if it's stuck on `dashboards`, CSV rows are still CSS-hidden regardless of this fix — fix is "toggle to Data" or shipping #2 of suite #1B's auto-switch logic.)
- **Rail view-switch swaps the main surface (CAS_3BCD6727, 2026-05-31):** The "Data ↔ Dashboards" rail toggle (`#wsRailView` / `data-rail-seg`) is more than a rail filter — toggling also auto-restores the last-opened file of the new view kind in `rp-surface`. Memory lives in `lastFileRidByView = { data, dashboards }`; the `loadFile` data branch and dashboard branch each update their slot on successful render. The `onChange` handler's behavior: if `activeFileRid` is null (initial mount, no surface yet) it's a no-op; otherwise it calls `loadFile(lastFileRidByView[view])` if a file is remembered, else leaves the surface as-is so the user picks from the visible rail. Designer-bound chart rids (CHT_) and untyped envelopes intentionally don't update either slot — only data/dashboard file_types do.

## Related

- [Frontend pillar landing](../../../index.md)
