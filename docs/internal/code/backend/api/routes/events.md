---
title: backend/crates/api/src/routes/events.rs
source: ../../../../../../backend/crates/api/src/routes/events.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# events.rs

## Purpose

`/api/events` — runtime observability log.

GET  /api/events        recent events, newest first
(filter: `?level=` `?kind=` `?limit=`)
GET  /api/events/:rid   one event
POST /api/events        a frontend-reported event — `origin` is
forced to `frontend`; `user` / `session`
are resolved server-side from the
`rp_session` cookie, never trusted from
the request body.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
