---
title: backend/crates/data/src/steps/util.rs
source: ../../../../../../backend/crates/data/src/steps/util.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# util.rs

## Purpose

Step-engine helpers: JSON-arg extraction, column-keep projection,
filter-predicate compilation, date / snake-case utilities.

Split out of `steps/mod.rs` so the cleaning-step dispatcher there can
stay focused on the per-kind match. All helpers are `pub(super)` —
consumed only by the dispatcher, never by external callers.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
