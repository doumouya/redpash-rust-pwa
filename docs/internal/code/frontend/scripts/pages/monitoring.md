---
title: frontend/scripts/pages/monitoring.js
source: ../../../../../frontend/scripts/pages/monitoring.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# monitoring.js

## Purpose

Monitoring — the system telemetry surface. Same shell pattern as Home (rail + body). Static rail groups: REQUESTS / AUDITS / CATALOG. Tabs render observability data (requests, events, runs, findings, steps, charts, optimization, user activity).

## Public surface

- Default export: page mount.
- Per-tab specs from pages/monitoring/tabs.js.
- M-1 request-detail modal: openRequestReplay(rid) reads /api/monitoring/request/:rid.

## Drift-prone areas

- Request-detail modal uses the shared rp-modal-* atom + --rp-modal-w width override.
- Post-fetchList hook order: `colsCtrl.applyColumnOrder()` must fire before `colsCtrl.applyHiddenColumns()` so the drag-reorder lands before positional hide indexing — see [list-page.js](../list-page.md).
- **ADMIN group platform-admin gated (CAS_274EDF3B, 2026-05-31):** Module-scoped `isPlatformAdmin` boolean resolved once at mount via `api.get("/me")`; defaults `false` until `/me` lands (re-renders the rail when it does, so an admin sees the group appear without an interaction). `renderRail` filters `MON_GROUPS` by `g.name !== "ADMIN" || isPlatformAdmin` so non-admins never see the tabs. Backend `/admin/*` endpoints are the real auth (leak-free 404 for non-admins) — the FE filter is a UX hide, not a security gate. Initial tabs: Cleanings (`/admin/steps`, moved from AUDITS + renamed), Fields (`/admin/fields`, write/read/none access cells per RBAC tier — chip-enum editor ready when other Torv's PUT slice lands), Audit catalog (`/admin/audit-catalog`, severity buckets + diff-vs-prev). Phase B adds Users/Companies/Teams/Memberships (move from Home) + RBAC introspection panel + Sessions (when ready).
- **`viewSpec.itemsKey` unwrap (CAS_274EDF3B, 2026-05-31):** Audit catalog returns `{tools: [...]}` instead of `{rows: [...]}`, so `fetchList` honors `viewSpec.itemsKey` to point at the array. Falls back to `data?.rows` for the standard Page<T> shape; existing tabs unchanged.

## Related

- [Frontend pillar landing](../../../index.md)
