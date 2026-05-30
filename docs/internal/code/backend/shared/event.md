---
title: backend/crates/shared/src/event.rs
source: ../../../../../backend/crates/shared/src/event.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# event.rs

## Purpose

Event DTOs — the runtime observability log.

`Event` is the persisted record (one `events` row). `EventReport`
is the slimmer body the frontend POSTs to `/api/events` — identity
(`user` / `session`) is stamped server-side from the request cookie,
never trusted from the client, and `origin` is forced to `frontend`.

## Public surface

- `pub struct Event` — struct
- `pub struct EventReport` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
