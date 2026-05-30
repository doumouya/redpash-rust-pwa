---
title: backend/crates/shared/src/filter.rs
source: ../../../../../backend/crates/shared/src/filter.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# filter.rs

## Purpose

Filter spec — wire format for `PageQuery.filters`.

Two shapes are accepted; both serialise as JSON in the query string.

## Public surface

- `pub struct FilterSpec` — struct
- `pub enum FilterOp` — enum
- `pub enum FilterNode` — enum
- `pub struct FilterGroup` — struct
- `pub enum GroupOp` — enum

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
