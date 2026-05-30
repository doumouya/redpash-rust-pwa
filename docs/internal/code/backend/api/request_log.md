---
title: backend/crates/api/src/request_log.rs
source: ../../../../../backend/crates/api/src/request_log.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# request_log.rs

## Purpose

Per-request performance capture — fire-and-forget writes to the
`request_log` table.

[`record`] persists one row per HTTP request (route, status,
latency) WITHOUT blocking the response: it clones the pool (cheap —
`Arc` inside) and spawns the INSERT on a detached task. Same rule as
`event::record` — the measurement layer must never slow, or fail,
the thing it measures.

## Public surface

- `pub fn record` — function
- `pub fn normalize_route` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
