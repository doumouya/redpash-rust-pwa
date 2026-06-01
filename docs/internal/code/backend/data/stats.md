---
title: backend/crates/data/src/stats.rs
source: ../../../../../backend/crates/data/src/stats.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# stats.rs

## Purpose

Column statistics + the file-level **cleanness score**.

`unique_values` iterates a single column, collects up to ~3× the
requested cap into a HashSet (to keep the result diverse when the
column is huge), then sorts and truncates. Output is alphabetical
ASCII order; the frontend renders as a `<datalist>`.

## Public surface

- `pub const SENTINELS` — constant
- `pub struct SentinelOccurrence` — struct
- `pub fn find_sentinels` — function
- `pub struct CleannessReport` — struct
- `pub fn cleanness` — function
- `pub fn cleanness_report` — function
- `pub fn count_cell_diffs` — function (count-only before/after diff)
- `pub struct CellChange` / `pub struct RenamePair` / `pub struct FrameDiff` — the structured diff types
- `pub fn diff_frames` — function: the richer sibling of `count_cell_diffs` powering the generic "preview before apply" feature (rows Δ, cells changed/nulled, cols added/removed/renamed, capped Before|After sample; reuses `av_to_owned` so cross-dtype casts compare by displayed value)
- `pub fn count_fully_null_rows` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
