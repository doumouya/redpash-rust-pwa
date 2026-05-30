---
title: backend/crates/data/src/distinct.rs
source: ../../../../../backend/crates/data/src/distinct.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# distinct.rs

## Purpose

Single-column distinct values — drives filter-predicate
autocomplete on the workspace's filter panel.

Cousin of `joins::unique_per_col`, deliberately separate: that one
is pairwise across every column in the frame (joins detector
needs that shape), this one scans exactly one column. Calling the
pairwise function for a single-column lookup would scan N-1
columns for nothing on every request.

## Public surface

- `pub const MAX_UNIQUE` — constant
- `pub struct DistinctResult` — struct
- `pub fn for_column` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
