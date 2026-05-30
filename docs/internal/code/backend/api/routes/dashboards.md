---
title: backend/crates/api/src/routes/dashboards.rs
source: ../../../../../../backend/crates/api/src/routes/dashboards.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
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

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
