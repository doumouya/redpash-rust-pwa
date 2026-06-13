---
title: backend/crates/api/src/db/mod.rs
source: ../../../../../../backend/crates/api/src/db/mod.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-06-14
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
- **Lean slim (CAS_C8A9):** the case/comment helpers (`list_cases`/`count_cases`/
  `find_case`/`insert_case`/`set_case_person`/`update_case`/`delete_case`/
  `case_is_internal` + `CASE_SELECT`/`CASE_USER_JOINS`/`CaseRow`, and the comment
  cluster `list_comments_for_case`/`find_comment`/`insert_comment`/`update_comment`/
  `delete_comment`/`list_activity_for_case` + `CommentRow`/`COMMENT_*`) were
  **removed** with the trimmed cases route — only `list_categories` survives. The
  orphaned company/team/user-list helpers (`list_companies`/`get_company`/
  `company_owner_count`/`update_company`/`list_teams`/`get_team`/`create_team`/
  `update_team`/`delete_team`/`list_company_members`/`add_company_member`/
  `update_company_member_role`/`remove_company_member` + `TEAM_COLS`/`TeamRow`, and
  `db::users::list_users`) were removed with the deleted `companies`/`teams`/`users`
  routes. **Tables + the still-used helpers stay** (`company_role`,
  `users_share_company`, `user_sole_owner_objects`,
  `delete_company`, `delete_membership`, `insert_membership` — admin/monitoring SQL
  joins those). `create_company` + `COMPANY_COLS` were **removed** in the AC-7 tail
  (2026-06-14): the bootstrap internal-company seeding was their only caller, so
  cutting that (with the dead `internal_company_id` AppState field) left them
  orphaned. The full multi-tenant set is in the `full-app-pre-slim` snapshot.
- `memberships` is an entity→entity→role edge with PK `(object, member_redpash_id, role, context_role)` (migration `20260531000000` + column rename `20260531000001`). A principal can hold multiple roles per object. See [entity-membership-model](../../../../specs/rbac/entity-membership-model.md).
- **Sole-owner blocker** lives at `db::user_sole_owner_objects`. Used by the scrub-retain user-deletion flow (CAS_46BA67713EC84871991D3E7475598B47) to 409 with the blocking object rids before the scrub transaction starts. `DISTINCT` against the widened PK because the same user can hold multiple `role='owner'` rows on the same object (different `context_role`); the blocker fires once per object.
- `insert_membership(scope, scope_id, user_id, role, context_role: Option<&str>)` is the generic insert. `context_role` is `NOT NULL` with DB default `''`, but sqlx binds Rust `None` as SQL `NULL` (bypassing the default) — the helper coerces `None → ""` so any route handler can pass `None` for "no specific context role" without each one coalescing. Caller: the admin `POST /api/admin/memberships` handler.
- **`list_events(.., viewer: Option<&str>)`** still takes a `viewer` param, but the route (`events.rs::list`) passes `None` in the lean build (single-user); the `Some(caller)` tenant-scope branch is dormant. Keep symmetric with get_one.
## Related

- [Backend pillar landing](../../index.md)
