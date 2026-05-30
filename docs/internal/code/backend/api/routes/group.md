---
title: backend/crates/api/src/routes/group.rs
source: ../../../../../../backend/crates/api/src/routes/group.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# group.rs

## Purpose

`/api/group/preview` — the stateless grouping engine.

Takes a source file id + a grouping spec, runs up to three Polars
queries (details, subtotals, grand total), and returns each section
independently. Stateless — nothing is stored; the Designer and
dashboard widgets call it for live preview.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
