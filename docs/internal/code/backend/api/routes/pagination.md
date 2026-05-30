---
title: backend/crates/api/src/routes/pagination.rs
source: ../../../../../../backend/crates/api/src/routes/pagination.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# pagination.rs

## Purpose

Pagination helpers shared by every `Page<T>`-returning handler.

The same two helpers lived in `admin.rs` and `monitoring.rs` as
byte-identical copies for the lifetime of the two crates; consolidating
here per the 2026-05-24 rust-dedup audit. `pub(super)` so any
`routes/*.rs` sibling can `use super::pagination::{paginate, build_page}`
without making the helpers part of the api crate's external surface.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
