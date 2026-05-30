---
title: backend/crates/shared/src/dashboard.rs
source: ../../../../../backend/crates/shared/src/dashboard.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# dashboard.rs

## Purpose

Dashboard resource DTOs.

A `Dashboard` is the persisted record (id + title + spec + favorite
+ folder), stored as a dashboard-typed `project_files` row.
`DashboardSpec` is the inner shape — a layout template + a list of
widgets; each widget references a chart by id.

## Public surface

- `pub struct Dashboard` — struct
- `pub struct DashboardSpec` — struct
- `pub struct Widget` — struct
- `pub struct DashboardRequest` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
