---
title: backend/crates/data/src/clean.rs
source: ../../../../../backend/crates/data/src/clean.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# clean.rs

## Purpose

Auto-clean — the conservative, always-safe transforms RedPash can
apply to a CSV with no human in the loop. Powers the landing-page
demo's "drop it → get it back clean" path.

Deliberately narrow: only fixes that never lose real data and never
make a judgment call —
1. trim leading / trailing whitespace from string cells;
2. blank obvious junk placeholders (the canonical `SENTINELS`) and
whitespace-only cells to a real null;
3. drop fully-identical duplicate rows.

## Public surface

- `pub struct CleanSummary` — struct
- `pub fn auto_clean` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
