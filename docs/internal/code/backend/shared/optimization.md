---
title: backend/crates/shared/src/optimization.rs
source: ../../../../../backend/crates/shared/src/optimization.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# optimization.rs

## Purpose

Optimization map — the wire DTO for `/api/monitoring/optimization-points`.

See `docs/internal/specs/optimization-map.md`. One row pairs a
known optimization opportunity (subsystem + phase + horizon)
with the metadata to compute its live measured value, and ships
the evaluated value alongside the static prose. The frontend
redtable renders both in the same view.

## Public surface

- `pub struct OptimizationPoint` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
