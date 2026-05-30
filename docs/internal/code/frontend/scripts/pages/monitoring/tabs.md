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

- MON_TABS — tab inventory across rail groups (REQUESTS / AUDITS / CATALOG).
- MON_GROUPS — rail-group definitions.

## Drift-prone areas

- Endpoint contracts with /api/monitoring/* routes.

## Related

- [Frontend pillar landing](../../../../index.md)
