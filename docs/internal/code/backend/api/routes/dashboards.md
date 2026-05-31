---
title: backend/crates/api/src/routes/dashboards.rs
source: ../../../../../../backend/crates/api/src/routes/dashboards.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# dashboards.rs

## Purpose

`/api/dashboards/*` — CRUD + favourite toggle.

A dashboard is a layout of widgets, persisted as a dashboard-typed
`project_files` row (`file_type='dashboard'`) — the "everything is a
File" object model, the same one charts use. Widgets reference
charts by id in the `spec` JSON. This module persists the layout;
the render-time data fetch is widget-by-widget on the frontend.

## Public surface

- `pub fn routes` — function

## Gates

- `get_one` — `dashboard.view` (cascade + the `is_public` widen).
- `patch_one` / `update` / `delete_one` — `require_grant`, `effective() >= Admin`
  (owner via project `scope` `Owner`; project/company admin via cascade;
  platform). `is_public` (publish) is owner-tier per catalog — coarsened to the
  object gate here; per-field atom enforcement is v3.
- `set_favorite` — stays `ensure_owner`: `is_favorite` is a personal `own`-only
  pin ("only the owner toggles their own"), so admin reach is intentionally
  *not* granted.
- `create` — stays gated on the parent project's owner.

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
