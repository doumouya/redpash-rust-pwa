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
- **`list_companies` / `list_teams` my_role subqueries are precedence-ordered (LIMIT 1)** — the widened PK lets a user hold multi-role on one object; a plain `LEFT JOIN memberships` (or unordered subselect) returns multiple rows per parent → either duplicate Summary entries or a "more than one row" 500. Both helpers rank `owner > admin > member > viewer` and `LIMIT 1`. The matching admin list endpoints repeat the shape inline; keep the four in sync.
- **Team helpers** (`create_team`, `get_team`, `list_teams`, `update_team`, `delete_team`) mirror the company shape with one wrinkle: `create_team` requires a `company_id` (`teams.company_id` is NOT NULL) — the FK violation 23503 surfaces to the route as 404 "company not found". `update_team` only allows `name`; moving a team across companies (`company_id` swap) is intentionally not exposed here.
- **`create_team(kind: &str)`** — 2026-05-31 second cut: the helper accepts a `kind` discriminator (`team` / `department`); `TEAM_COLS` + `TeamRow` + `Team` DTO all carry it. The INSERT binds `(redpash_id, company_id, name, kind)`. `entities.type` stays `'team'` for both kinds — `kind` is a teams-table column, not an entity-registry value (departments share the team entity type). `list_teams` also SELECTs `t.kind` so the Home Teams tab surfaces it.
- **Case people can be teams, not just users.** `CASE_USER_JOINS` LEFT-JOINs the `Reporter` / `Case Owner` membership member against BOTH `users` (alias `r`/`a`) AND `teams` (alias `r_t`/`a_t`); `CASE_SELECT` does `COALESCE(r.display_name, r_t.name) AS reporter_display_name` (same for assignee). This realises CAS_913's "HR team as case-reporter" design without adding a typed member column. `case_is_internal` + the `source=internal/external` filter in `list_cases`/`count_cases` carry a second EXISTS branch checking `teams.company_id = $internal_company` so a team-reporter is internal when its parent company IS — a user-reporter is internal when they have a membership row on it. Both sites stay in sync; updating one without the other = team-reported cases mis-classified.

## Related

- [Backend pillar landing](../../index.md)
