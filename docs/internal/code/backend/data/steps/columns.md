---
title: backend/crates/data/src/steps/columns.rs
source: ../../../../../../backend/crates/data/src/steps/columns.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# columns.rs

## Purpose

Column-shape + name cleaning steps: drop columns by name, keep a
whitelist, rename one, normalise all headers to snake_case, or
find-and-replace a substring across every header. Pure schema
mutations — column VALUES are untouched (those live in `cells`).

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
