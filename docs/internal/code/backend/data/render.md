---
title: backend/crates/data/src/render.rs
source: ../../../../../backend/crates/data/src/render.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# render.rs

## Purpose

TODO: implement in phase 2-3.
See 07-redtable-schemas.md + 08-cleaner-workspace.md for the algorithm.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
