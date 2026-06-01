---
title: frontend/scripts/pages/monitoring/tabs.js
source: ../../../../../../frontend/scripts/pages/monitoring/tabs.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages/monitoring
last modified date: 2026-05-30
---

# tabs.js

## Purpose

Monitoring page tab definitions — slice 5 of the god-object decomposition. Mirror of slice 4's pages/home/tabs.js extract.

## Public surface

- MON_TABS — tab inventory across rail groups (REQUESTS / AUDITS / ADMIN / OPTIMIZATION / USERS / CATALOG).
- MON_GROUPS — rail-group definitions. Each carries a `surface` tag
  (`"monitoring"` = system observability | `"admin"` = Admin Console / org
  management) that partitions the rail into the two top-level views the
  `#rpMonRailView` switcher toggles (CAS_274EDF3B). Today: ADMIN → `admin`; all
  other groups → `monitoring`.

## Drift-prone areas

- Endpoint contracts with /api/monitoring/* routes; ADMIN tabs hit /api/admin/* (gated server-side by `is_platform_admin`).
- **ADMIN group is platform-admin-only (CAS_274EDF3B, 2026-05-31).** Rail render filters out the whole group for non-admins (see [monitoring.md](../monitoring.md)'s "ADMIN group platform-admin gated" drift bullet). Order in MON_GROUPS: REQUESTS → AUDITS → ADMIN → OPTIMIZATION → USERS → CATALOG.

## Related

- [Frontend pillar landing](../../../../index.md)
