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
- `patch_project` — `require_grant`, `effective() >= Admin` (owner is direct
  `Owner`; company admin via cascade; platform). The **owner-grade fields**
  (`owner_id` transfer, `company_id` re-scope, `is_default`) are guarded inside
  the handler to the project owner / platform admin (catalog reach `own · all`,
  owner-only) — they ride the same handler but can't be set by a mere admin.
- `delete_project` — `require_grant`, `effective() >= Owner` (catalog
  `own · company · all`, **owner-only at company tier**: project owner, company
  owner, or platform — never a company admin). Default-project guard unchanged.
- Per-field update atoms (name vs status vs …) are coarsened to one object-level
  gate; field-level enforcement is the v3 custom-role layer.

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
