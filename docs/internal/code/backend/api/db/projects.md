---
title: backend/crates/api/src/db/projects.rs
source: ../../../../../../backend/crates/api/src/db/projects.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-30
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
- `pub fn list_projects` — function
- `pub fn get_project` — function
- `pub fn update_project_meta` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
