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

## Related

- [Frontend pillar landing](../../index.md)
