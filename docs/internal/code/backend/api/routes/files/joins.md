---
title: backend/crates/api/src/routes/files/joins.rs
source: ../../../../../../../backend/crates/api/src/routes/files/joins.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# joins.rs

## Purpose

`/api/files/:rid/joins` — detect candidates + create the join.

Split out of `files/mod.rs` so the join detection + materialisation
path (Polars `joins::detect_pair` + `joins::execute`, filter-aware,
cleanness-scored, CSV-streamed) lives next to its request/response
types instead of being buried in the 1.4k-LOC routes module.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
