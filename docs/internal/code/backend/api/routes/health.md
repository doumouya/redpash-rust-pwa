---
title: backend/crates/api/src/routes/health.rs
source: ../../../../../../backend/crates/api/src/routes/health.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# health.rs

## Purpose

`/api/health` — liveness + (eventually) DB readiness.

Phase 1: just `{"status": "ok"}` so the frontend router and any uptime
probe can confirm the server boots. Phase 2 adds a `?deep=1` flag that
also pings Postgres.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
