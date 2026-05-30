---
title: backend/crates/api/src/db/sentinels.rs
source: ../../../../../../backend/crates/api/src/db/sentinels.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-30
---

# sentinels.rs

## Purpose

`sentinel_submissions` + `global_sentinels` SQL helpers.

Two functions for the cleanness-vocabulary plumbing:
- Read the globally-promoted canonicals (≥2 distinct users; the
promotion threshold lives in the `global_sentinels` view).
- Record one user's submission as a vote toward promotion.

## Public surface

- `pub fn list_global_sentinels` — function
- `pub fn record_sentinel_submission` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
