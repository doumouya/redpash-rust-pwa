---
title: backend/crates/api/src/db/sessions.rs
source: ../../../../../../backend/crates/api/src/db/sessions.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-30
---

# sessions.rs

## Purpose

Session-row helpers — the `sessions` table holding the cookie
→ user-rid mapping. The auth flow creates a row on login,
the request middleware reads it on every authed call, the
logout flow deletes it.

## Public surface

- `pub fn create_session` — function
- `pub fn find_session_user` — function
- `pub fn delete_session` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
