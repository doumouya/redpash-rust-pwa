---
title: backend/crates/api/src/db/projects.rs
source: ../../../../../../backend/crates/api/src/db/projects.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-31
---

# projects.rs

## Purpose

`projects` table CRUD + the shared ProjectSummary SELECT.

Slice 4 of the db/mod.rs decomposition. Holds:

## Public surface

- `pub fn find_default_project` — function
- `pub fn insert_project` — function
- `pub fn ensure_default_project` — function
- `pub fn find_project_by_name` — function
- `pub fn ensure_named_project` — function
- `pub fn list_projects(pool, caller)` — **reach-aware** (CAS_3B0DAD92): returns
  projects the caller reaches via platform-admin (`users.role='admin'`), direct
  membership (any role), OR company owner/admin cascade — mirroring
  `rbac::require_view`. (Was strict direct-ownership; a cascade-reachable project
  showed in Home/Files via `/admin/files` but vanished from Workspace's
  `/api/projects` list.) The `om` join still resolves the OWNER for display.
- `pub fn get_project` — function
- `pub fn update_project_meta` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- Owner transfer (`update_project_meta`) replaces the owner edge by delete-then-insert (no `ON CONFLICT (object,user)`) under the widened membership PK — migration `20260531000000`.

## Related

- [Backend pillar landing](../../index.md)
