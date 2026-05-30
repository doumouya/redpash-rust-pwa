---
title: backend/crates/data/src/steps/cells.rs
source: ../../../../../../backend/crates/data/src/steps/cells.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# cells.rs

## Purpose

Cell-value cleaning steps: single-cell mutation, null-fill,
per-column type coercion, full-column case folding,
find-and-replace, sentinel→replacement.

All preserve the frame's shape; only cell values change.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
