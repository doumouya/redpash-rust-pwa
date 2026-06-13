---
title: backend/crates/api/src/db/users.rs
source: ../../../../../../backend/crates/api/src/db/users.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-06-13
---

# users.rs

## Purpose

`users` row CRUD + memberships join + Google-OAuth upsert.

Slice 3 of the db/mod.rs decomposition. Holds:

## Public surface

- `pub fn find_user_by_username` — function
- `pub fn find_user_by_id` — function
- `pub fn list_memberships_for_user` — function
- `pub fn update_user` — function
- `pub fn patch_user_prefs` — function
- `pub fn insert_user` — function
- `pub fn scrub_user_tx` — function (replaces `delete_user`, scrub-retain transaction per [runbook CAS_46BA…](../../../../runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md))

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **No hard `DELETE FROM users`.** The pre-2026-05-31 `db::delete_user` was deleted in CAS_46BA67713EC84871991D3E7475598B47 — hard DELETE CASCADEd memberships (including reporter / case-owner / project-owner rows) and broke the audit-retention contract. `scrub_user_tx` is the only allowed user-lifecycle path; sole-owner blocker is enforced caller-side via `db::user_sole_owner_objects` (db/mod.rs). Don't reintroduce a hard-delete helper "for testing" — the discipline is the contract.
- **`list_users` was removed in the lean slim (CAS_C8A9)** with the deleted `/users` route — the only caller. Its see-down `viewer`-scoped form (CAS_AF2690C0) is preserved in the `full-app-pre-slim` snapshot. The remaining user helpers here are single-row lookups + the lifecycle path, no list surface.

## Related

- [Backend pillar landing](../../index.md)
