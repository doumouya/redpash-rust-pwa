---
title: backend/crates/data/src/steps/mod.rs
source: ../../../../../../backend/crates/data/src/steps/mod.rs
owner: Gus
section: Internal · Code · backend · data · steps
last modified date: 2026-05-30
---

# mod.rs

## Purpose

Apply / replay cleaning steps against a Polars DataFrame.

`apply` is the single switch from `kind` (string) → Polars op. Every
handler in the api crate that mutates a file's state goes through
`replay`: the canonical file is the on-disk CSV; the persistent
history is `project_steps`; the current view is the replay result.

## Public surface

- `pub fn apply` — function
- `pub fn replay` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
