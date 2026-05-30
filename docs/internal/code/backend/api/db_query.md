---
title: backend/crates/api/src/db_query.rs
source: ../../../../../backend/crates/api/src/db_query.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# db_query.rs

## Purpose

DB-layer observability — fire-and-forget per-query capture into the
`db_query_log` table (the DB sibling of `request_log`). A `tracing`
Layer taps sqlx's own query-log events (target `sqlx::query`), so
there are ZERO call-site changes. Scope:
`docs/internal/observability/db-monitoring.md`.

Measuring the DB must never slow it: capture is fire-and-forget
(`tokio::spawn`) and the layer no-ops until the pool is set
([`init_pool`], called after `AppState` boots — tracing inits before
the pool exists, hence the `OnceLock`).

## Public surface

- `pub fn init_pool` — function
- `pub fn layer` — function
- `pub struct DbQueryLayer` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
