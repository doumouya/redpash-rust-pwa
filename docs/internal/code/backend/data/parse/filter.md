---
title: backend/crates/data/src/parse/filter.rs
source: ../../../../../../backend/crates/data/src/parse/filter.rs
owner: Gus
section: Internal · Code · backend · data · parse
last modified date: 2026-05-30
---

# filter.rs

## Purpose

Filter expression compilation for `page()` + `apply_filter()`.

Decoupled from the CSV-parsing core (`super`) so the per-FilterOp
casing rules + tree-collapse + global-search expressions live in one
place instead of crowding the parse-pipeline module. Only
`apply_filter` is re-exported publicly through `parse`; the rest are
`pub(super)` so `page()` in `mod.rs` keeps calling them
unqualified-after-`use`.

## Public surface

- `pub fn apply_filter` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
