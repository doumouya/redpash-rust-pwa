---
title: backend/crates/api/src/routes/users.rs
source: ../../../../../../backend/crates/api/src/routes/users.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# users.rs

## Purpose

`/api/users` — user directory.

Powers the Objects page's owner-reassignment picker and the Users
tab. Single-tenant for now: returns every user.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
