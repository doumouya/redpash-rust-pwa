---
title: frontend/scripts/pages/monitoring.js
source: ../../../../../frontend/scripts/pages/monitoring.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-07
---

# monitoring.js

## Purpose

Monitoring — the **system-observability surface** (REQUESTS / AUDITS / OPTIMIZATION /
USERS / CATALOG). Same shell pattern as Home (rail + body). **Observability-only as of
Slice B (2026-06-07):** the Admin Console surface — the `#rpMonRailView` rail-seg
switcher, the ADMIN group (steps / fields / audit_catalog), the per-mount `/me` admin
gate + `.rp-mon-admin`, and the `accessChip` helper — was **removed and moved to
`pages/admin-console.js`** (the Admin app). There is no longer a rail-seg or a
`data-rail-view` surface split; all remaining groups are the one Monitoring surface.
The `/monitoring` route stays platform-admin gated at the route (`ROUTES` `admin: true`)
+ the backend `require_platform_admin_mw` on the `/monitoring` nest.

## Public surface

- Default export: page mount.
- Per-tab specs from pages/monitoring/tabs.js.
- M-1 request-detail modal: openRequestReplay(rid) reads /api/monitoring/request/:rid.

## Drift-prone areas

- **Design-language rollout — fully migrated to framework atoms (2026-06-05).** This page is
  `rt-*`-clean (rail `rp-rail*`, tables `rp-table`, mono labels `rp-mono-pill`, severity `rp-tone-low/mid/high`
  — note the **single** hyphen, was `rt-tone--*`, the rename trap — cards `rp-card*`, rows-dropdown `rp-menu-item`,
  field label `rp-label`, modal-close `rp-btn-icon rp-btn-icon--sq`). Markup + the JS-rendered rail/tables move
  in lockstep. The refresh **spinner** toggles `rp-toolbar-spin is-spinning` together (the framework split the
  legacy single `.rt-spinning` class into base + state). (The `data-rail-view` surface-filter + `.rp-mon-admin`
  admin-gate composition rules were **removed with the Admin Console split**, Slice B 2026-06-07 — they moved with
  the page that uses them, not here.) The list/redtable surface (`#rpMonView`) still emits `rt-*` — that's the shared
  list-page/redtable lane, not this page. Active-tab highlight uses `.active` set in `activate()`; note the rail
  tab does not always carry `.active` on first paint (pre-existing — verified identical before the migration).
- Request-detail modal uses the shared rp-modal-* atom + --rp-modal-w width override.
- The request-modal Timeline heading renders the `rp-title` atom inside
  `.rp-mon-modal-timeline` (sized by the `.rp-mon-modal-timeline .rp-title` context,
  not a `rp-mon-modal-section-title` class — CAS_37B2E1BF).
- Post-fetchList hook order: `colsCtrl.applyColumnOrder()` must fire before `colsCtrl.applyHiddenColumns()` so the drag-reorder lands before positional hide indexing — see [list-page.js](../list-page.md).
- **ADMIN group / admin gate REMOVED — moved to admin-console.js (Slice B, 2026-06-07).** The ADMIN group (Cleanings / Fields / Audit catalog), the module-scoped `isPlatformAdmin` per-mount `/me` gate, and the rail-seg surface split all moved to [admin-console.js](admin-console.md). Monitoring no longer filters `MON_GROUPS` by admin claim — all remaining groups are visible to anyone who can reach the page (the whole `/monitoring` route is platform-admin gated). Historical context (CAS_274EDF3B) lives in the admin-console doc now.
- **`viewSpec.itemsKey` unwrap (CAS_274EDF3B):** `fetchList` still honors `viewSpec.itemsKey` to point at a non-`rows` array, falling back to `data?.rows` for the standard `Page<T>` shape — but the audit-catalog tab that used it (`{tools: [...]}`) **moved to admin-console.js**, so no remaining monitoring tab sets `itemsKey` today. The mechanism is retained for future non-`Page<T>` observability endpoints.

## Related

- [Frontend pillar landing](../../../index.md)
- [admin-console.js](admin-console.md) — the Admin Console surface split out of this page (Slice B).
