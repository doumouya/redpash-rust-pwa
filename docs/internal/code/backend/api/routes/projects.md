---
title: backend/crates/api/src/routes/projects.rs
source: ../../../../../../backend/crates/api/src/routes/projects.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# projects.rs

## Purpose

`/api/projects` — full CRUD on the user's projects + their files.

GET    /                 list the caller's projects
POST   /                 create a new project
GET    /:rid             fetch one project summary
PATCH  /:rid             sparse metadata update (inline edits)
DELETE /:rid             delete (cascades to files / steps / dashboards)
GET    /:rid/files       list files in a project (cleaner landing)
*      /:rid/members      generic object-member CRUD (nested members.rs)

## Public surface

- `pub fn routes` — project CRUD + a nest of the generic member router at
  `/:rid/members` (see [members.rs](members.md)). Reach-aware: a project owner
  *or* a company admin (cascade) manages project members.

## Gates

- `get_one` / `list_files` — `project.view` (member, incl. company cascade).
- `patch_project` / `delete_project` — still `ensure_owner` (owner-only);
  broadens to `require_grant` once member-management is exercised in the FE.

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
