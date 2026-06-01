---
title: backend/crates/api/src/routes/monitoring.rs
source: ../../../../../../backend/crates/api/src/routes/monitoring.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# monitoring.rs

## Purpose

`/api/monitoring` — read surface for the `/monitoring` page. **Platform-admin
only** (CAS_274EDF3B): the whole router is gated by
`routes::require_platform_admin_mw` (a `from_fn_with_state` layer on the
`/monitoring` nest in [routes/mod.rs](mod.md)) — non-admins get a leak-free 404
before any handler runs, so no per-handler gate lives here. Companion to the FE
topbar/route hide.

GET /api/monitoring/events?page&size&window&level&kind
GET /api/monitoring/audit-runs?page&size&tool
GET /api/monitoring/audit-findings?page&size&run&tool&kind
GET /api/monitoring/requests?page&size&window&route&status&method
GET /api/monitoring/requests/stats?window
GET   /api/monitoring/optimization-points?page&size&subsystem&status
PATCH /api/monitoring/optimization-points/:rid     (status flip)
GET /api/monitoring/events/stats?window=
GET /api/monitoring/audit-runs/stats
GET /api/monitoring/audit-findings/stats

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
