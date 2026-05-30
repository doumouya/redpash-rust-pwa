---
title: backend/crates/api/src/event.rs
source: ../../../../../backend/crates/api/src/event.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# event.rs

## Purpose

Runtime event capture — fire-and-forget writes to the `events` table.

`record(pool, draft)` persists an event WITHOUT blocking the caller:
it clones the pool (cheap — `Arc` inside) and spawns the INSERT on a
detached task. A failed insert is logged and swallowed. The rule is
absolute — the observability layer must never slow down, or fail,
the thing it observes.

## Public surface

- `pub struct EventDraft` — struct
- `pub fn record` — function
- `pub struct EventBuilder` — struct
- `pub fn info` — function
- `pub fn warn` — function
- `pub fn error` — function
- `pub struct EventInfo` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
