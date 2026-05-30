---
title: backend/crates/shared/src/monitoring.rs
source: ../../../../../backend/crates/shared/src/monitoring.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# monitoring.rs

## Purpose

Monitoring summaries — slim wire shapes for the /api/monitoring
list endpoints.

Each `*Summary` is a *list-projection*: enough fields for the
redtable + ranked-table views in `frontend/scripts/pages/monitoring.js`,
omitting the heavy detail JSONB (`context`, `payload`, `detail`).
Detail views (per-event, per-run, per-finding) live behind the
existing per-rid endpoints — `/api/events/:rid` already serves
the full `Event`.

## Public surface

- `pub struct EventSummary` — struct
- `pub struct AuditRunSummary` — struct
- `pub struct AuditFindingSummary` — struct
- `pub struct RequestSummary` — struct
- `pub struct DbQuerySummary` — struct
- `pub struct RouteStat` — struct
- `pub struct RequestsStats` — struct
- `pub struct LatencyBucket` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
