---
title: frontend/scripts/pages/monitoring/tabs.js
source: ../../../../../../frontend/scripts/pages/monitoring/tabs.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages/monitoring
last modified date: 2026-06-07
---

# tabs.js

## Purpose

Monitoring page tab definitions — slice 5 of the god-object decomposition. Mirror of slice 4's pages/home/tabs.js extract.

## Public surface

- MON_TABS — tab inventory across rail groups (REQUESTS / AUDITS / OPTIMIZATION / USERS / CATALOG).
  The **ADMIN group + its tabs (steps / fields / audit_catalog) no longer live here** —
  they moved to `pages/admin-console.js`'s `ADMIN_VIEWS` with the Admin Console split
  (Slice B, 2026-06-07).
- MON_GROUPS — rail-group definitions. Each still carries a `surface` tag, but it is
  now **inert**: with the ADMIN group gone there is no rail-seg to gate, so all
  remaining groups are `"monitoring"`. The field is retained only to keep
  `renderGroup`'s `data-surface` stamp stable; it no longer partitions the rail.

## Drift-prone areas

- Endpoint contracts with /api/monitoring/* routes. (The ADMIN tabs that hit /api/admin/* moved to admin-console.js — see [admin-console.md](../admin-console.md).)
- **No more ADMIN group / surface split (Slice B, 2026-06-07).** `MON_GROUPS` order is now REQUESTS → AUDITS → OPTIMIZATION → USERS → CATALOG. The `surface` field is kept but inert (no `#rpMonRailView` switcher exists anymore); see [monitoring.md](../monitoring.md)'s "ADMIN group / admin gate REMOVED" drift bullet.

## Related

- [Frontend pillar landing](../../../../index.md)
- [admin-console.js](../admin-console.md) — the page that now owns the moved ADMIN tabs (`ADMIN_VIEWS`).
