---
title: backend/crates/data/src/steps/rows.rs
source: ../../../../../../backend/crates/data/src/steps/rows.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# rows.rs

## Purpose

Row-shape cleaning steps: drop by index, drop by predicate(s),
drop nulls. Each is a function dispatched from `apply()` in
`super`.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
