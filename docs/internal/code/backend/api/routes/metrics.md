---
title: backend/crates/api/src/routes/metrics.rs
source: ../../../../../../backend/crates/api/src/routes/metrics.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# metrics.rs

## Purpose

`/api/metrics` — performance read surface over `request_log`.

GET /api/metrics?window=1h|24h|7d|30d   (default 1h)

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
