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
- `memberships` is now an entity→entity→role edge with PK `(object, member_redpash_id, role, context_role)` (migration `20260531000000` + column rename `20260531000001`). Membership helpers (`add_company_member`, `set_case_person`) replace-then-insert instead of `ON CONFLICT (object,user)` — a principal can hold multiple roles per object. See [entity-membership-model](../../../../specs/rbac/entity-membership-model.md).
- **Sole-owner blocker** lives at `db::user_sole_owner_objects` next to `db::company_owner_count`. Used by the scrub-retain user-deletion flow (CAS_46BA67713EC84871991D3E7475598B47) to 409 with the blocking object rids before the scrub transaction starts. `DISTINCT` against the widened PK because the same user can hold multiple `role='owner'` rows on the same object (different `context_role`); the blocker fires once per object.
- `insert_membership(scope, scope_id, user_id, role, context_role: Option<&str>)` is the generic insert. `context_role` is `NOT NULL` with DB default `''`, but sqlx binds Rust `None` as SQL `NULL` (bypassing the default) — the helper coerces `None → ""` so any route handler can pass `None` for "no specific context role" without each one coalescing. Callers: the admin `POST /api/admin/memberships` handler today; future team / project membership routes share the path.

## Related

- [Backend pillar landing](../../index.md)
