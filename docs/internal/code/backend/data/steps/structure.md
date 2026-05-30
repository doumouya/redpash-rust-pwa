---
title: backend/crates/data/src/steps/structure.rs
source: ../../../../../../backend/crates/data/src/steps/structure.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# structure.rs

## Purpose

Structure-changing cleaning steps: wrapped-CSV rescue,
concat two columns into one, split one column into many,
date column reformat (parse + restringify).

These reshape the frame's columns (count or types) rather than
mutate cell values in place.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
