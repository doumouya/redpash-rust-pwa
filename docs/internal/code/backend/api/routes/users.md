---
title: backend/crates/api/src/routes/users.rs
source: ../../../../../../backend/crates/api/src/routes/users.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
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
- **`DELETE /api/users/:rid` is the scrub-retain entry-point**, not a hard delete. Sole-owner blocker → 409 `kind='sole_owner_blocker'`; otherwise the response is `{ok:true, scrubbed:true}` and the user row remains with PII null + `status='archived'`. Mirrors the admin route at `routes/admin.rs::delete_user`. See [runbook CAS_46BA…](../../../../runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md). Emits `user_scrub` event (not `user_delete`) for honest audit-trail attribution.

## Related

- [Backend pillar landing](../../index.md)
