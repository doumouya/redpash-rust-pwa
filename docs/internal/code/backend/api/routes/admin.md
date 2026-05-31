---
title: backend/crates/api/src/routes/admin.rs
source: ../../../../../../backend/crates/api/src/routes/admin.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# admin.rs

## Purpose

`/api/admin` — org-wide read surface for the `/home` rail tabs.

GET /api/admin/users        ← Users tab
GET /api/admin/companies    ← Companies tab
GET /api/admin/memberships  ← Memberships tab    (?scope=project|company)
GET /api/admin/files        ← Files tab          (org-wide, not per-project)
GET /api/admin/charts       ← Charts tab         (project_files where file_type='chart')
GET /api/admin/steps        ← Steps tab          (every project_step across all files)

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **`DELETE /api/admin/users/:rid` is scrub-retain**, not hard delete. Self-delete guard (`rid == caller`) remains; sole-owner blocker enforced via `db::user_sole_owner_objects` → 409; otherwise scrub_user_tx runs and returns 204. Mirrors `routes/users.rs::delete_one`. See [runbook CAS_46BA…](../../../../runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md).

## Related

- [Backend pillar landing](../../index.md)
