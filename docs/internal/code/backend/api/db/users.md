---
title: backend/crates/api/src/db/users.rs
source: ../../../../../../backend/crates/api/src/db/users.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-30
---

# users.rs

## Purpose

`users` row CRUD + memberships join + Google-OAuth upsert.

Slice 3 of the db/mod.rs decomposition. Holds:

## Public surface

- `pub fn find_user_by_username` — function
- `pub fn find_user_by_id` — function
- `pub fn list_memberships_for_user` — function
- `pub fn list_users` — function
- `pub fn update_user` — function
- `pub fn patch_user_prefs` — function
- `pub fn insert_user` — function
- `pub fn delete_user` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
