---
title: backend/crates/data/src/lib.rs
source: ../../../../../backend/crates/data/src/lib.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-06-05
---

# lib.rs

## Purpose

# `data` — Pure-compute layer

Everything in this crate is HTTP-agnostic. The `api` crate calls
these functions and serialises the results; tests can exercise them
directly without spinning up a server.

## Public surface

- `pub enum DataError` — enum
- modules: `encoding` · `parse` · `dtype` · `dedup` · `joins` · `distinct` · `group_by` · `steps` · `stats` · `structure` · `export` · `clean` · `render` (native) · [`sql`](sql.md) (native) · `wasm` (wasm32)

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
