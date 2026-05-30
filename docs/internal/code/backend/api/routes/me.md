---
title: backend/crates/api/src/routes/me.rs
source: ../../../../../../backend/crates/api/src/routes/me.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# me.rs

## Purpose

`/api/me` — current user profile.

Resolution order:
1. If an `rp_session` cookie is present and resolves to a valid
session, return that user.
2. Otherwise, when OAuth is *not* configured (dev mode), fall
back to the bootstrap `state.dev_user`.
3. When OAuth *is* configured but no valid session is present,
return 401 so the frontend can redirect to the landing page.

## Public surface

- `pub fn routes` — function
- `pub fn resolve_user_rid` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
