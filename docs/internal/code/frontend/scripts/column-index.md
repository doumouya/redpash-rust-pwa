---
title: frontend/scripts/column-index.js
source: ../../../../frontend/scripts/column-index.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# column-index.js

## Purpose

Per-file distinct-values cache. Backed by GET /api/files/:rid/uniques?col=X&q=Y&limit=N (response: { values, total, truncated }). Caches keyed on (rid, col, q, limit) so subsequent reads from autocomplete / chip-picker / search hit memory instead of network.

## Public surface

- getUniques(rid, col, q, limit) — memoised fetch.
- invalidateColumnIndex(rid) — clears the per-file cache (called by workspace after a step apply).

## Drift-prone areas

- Cache invalidation contract with pages/workspace.js step-apply path; missed invalidation = stale distincts.

## Related

- [Frontend pillar landing](../../index.md)
