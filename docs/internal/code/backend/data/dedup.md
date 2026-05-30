---
title: backend/crates/data/src/dedup.rs
source: ../../../../../backend/crates/data/src/dedup.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# dedup.rs

## Purpose

Duplicate-row detection for the cleaner's dedup tool.

Two modes:
• Full-row : all column values must match (uses `df.is_duplicated`).
• By column: only the named subset must match (`df.select(cols)
.is_duplicated`).

## Public surface

- `pub struct DedupReport` — struct
- `pub struct DupRow` — struct
- `pub fn detect` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
