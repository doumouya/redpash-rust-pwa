---
title: backend/crates/api/src/routes/events.rs
source: ../../../../../../backend/crates/api/src/routes/events.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-03
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
- **`list` is company-scoped** (CAS_AF2690C0, leak 2/5): the handler resolves the caller, and passes `viewer = None` for platform admins (full cross-tenant feed) else `Some(caller)` to `db::list_events`, which restricts to events whose user shares a company with the caller (own + NULL-user system events pass). Symmetric with `get_one`'s `users_share_company` gate — **keep the two in sync**; a future change to one must mirror the other or the list/detail surfaces disagree.

## Related

- [Backend pillar landing](../../index.md)
