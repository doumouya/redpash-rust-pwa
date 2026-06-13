---
title: backend/crates/api/src/routes/projects.rs
source: ../../../../../../backend/crates/api/src/routes/projects.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-13
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

The `/:rid/members` generic-member nest was removed in the lean slim (CAS_C8A9)
when `members.rs` was deleted — single-user tool, no member management.

## Public surface

- `pub fn routes` — project CRUD + `/:rid/files`.

## Gates

NEUTERED in the lean single-user build (CAS_C8A9). The handlers still call the
`crate::rbac` gates (`require_view` / `require_grant` / `require_fields`), but in
the lean build those admit unconditionally with zero per-request SQL — the sole
user owns every project. The multi-tenant reach gates (`view` / `>= Admin` /
`>= Owner` + the owner-grade-field guards) are preserved in the
`full-app-pre-slim` snapshot.

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
