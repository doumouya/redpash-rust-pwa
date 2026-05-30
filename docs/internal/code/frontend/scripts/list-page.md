---
title: frontend/scripts/list-page.js
source: ../../../../frontend/scripts/list-page.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# list-page.js

## Purpose

Shared runtime for the rail-page list surfaces (Home + Monitoring). Both pages render the same shape: section head + chip strip + KPI tiles + chart cards + paged table + pager. Pure HTML builders + chart lifecycle live here; per-page orchestration in the page scripts.

## Public surface

- mountListPage(el, spec) — paints the section shell.
- Builders for KPI strip, chart cards, sortable table headers, pager.
- Returns control surface: refresh, setActiveTab.

## Drift-prone areas

- Surface contract with pages/home.js + pages/monitoring.js — they reach into id-prefixed elements this module renders.
- **Column drag-reorder call-order contract:** `applyColumnOrder()` must run before `applyHiddenColumns()` in the post-fetchList hook chain. Hide positional-indexes tbody cells by TH position, so thead and tbody must be column-aligned first. `applyColumnOrder` itself assumes tbody is in **spec order** (the canonical state right after `fetchList` paints `tbody.innerHTML` wholesale) — the drop handler bypasses that assumption by calling the shared `reorderColumnDOM` helper directly with the live DOM order. Pre-2026-05-30 bug: an early-return when THs matched target left tbody in spec order, scrambling columns after any drag-reorder + paginate.
- **Sentinel-column anchoring:** any non-data-col-key TH/TD that frames the data columns (`SENTINEL_LEADING_CELL`, `SENTINEL_TRAILING_TH`, `SENTINEL_TRAILING_CELL`) MUST appear in the constants block at the top of the reorder section. `reorderColumnDOM` insert-anchors data THs **before** the first trailing sentinel (instead of `appendChild`-to-end), so a `.rp-home-hide-th` action column stays anchored at the right edge after reorder instead of getting pushed to position 0 by N consecutive appendChild calls. Same idea for tbody: leading sel cell and trailing hide cell get reattached around the reordered data cells. If a future feature adds a new sentinel column (e.g. a row-handle drag column on the left), add its class to the constants and the filters. 2026-05-31 bug: without this, drag-reorder on Home tabs with hideMeta scrambled the thead→tbody positional indexing (every header showed its right-neighbour's data) and `applyHiddenColumns` then hid the wrong columns.

## Related

- [Frontend pillar landing](../../index.md)
