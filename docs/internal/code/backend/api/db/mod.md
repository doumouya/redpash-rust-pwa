---
title: backend/crates/api/src/db/mod.rs
source: ../../../../../../backend/crates/api/src/db/mod.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-31
---

# mod.rs

## Purpose

Thin SQL helpers.

All queries are non-macro (`sqlx::query` + `query_as::<_, Row>`) so
the crate compiles without `DATABASE_URL` at build time. Each helper
takes a `&PgPool` and returns a domain DTO from `shared::*`.

## Public surface

- `pub use entities` — re-export
- `pub use sessions` — re-export
- `pub use sentinels` — re-export
- `pub use users` — re-export
- `pub use projects` — re-export
- `pub fn count_total` — function
- `pub struct FileFull` — struct
- `pub fn list_files_in_project` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- `memberships` is now an entity→entity→role edge with PK `(object, user_redpash_id, role, context_role)` (migration `20260531000000`). Membership helpers (`add_company_member`, `set_case_person`) replace-then-insert instead of `ON CONFLICT (object,user)` — a principal can hold multiple roles per object. See [entity-membership-model](../../../../specs/rbac/entity-membership-model.md).

## Related

- [Backend pillar landing](../../index.md)
