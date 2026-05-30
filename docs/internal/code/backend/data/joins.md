---
title: backend/crates/data/src/joins.rs
source: ../../../../../backend/crates/data/src/joins.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# joins.rs

## Purpose

Detect candidate join keys between two DataFrames.

Algorithm (port of clarna-django's `detect_join_keys`):
1. For each column in each frame, collect a HashSet of unique
non-empty stringified values, capped at `MAX_UNIQUE`.
2. Score every (this_col, other_col) pair by overlap coefficient:
|A ∩ B| / min(|A|, |B|)
This favours subset relationships (FK → PK) over Jaccard, which
penalises asymmetric sizes.
3. Drop pairs below `threshold` or where either set is tiny (<5
unique values), sort descending by score, cap at `max_results`.

## Public surface

- `pub const MAX_UNIQUE` — constant
- `pub struct JoinCandidate` — struct
- `pub fn detect_pair` — function
- `pub fn execute` — function
- `pub fn unique_per_col` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
