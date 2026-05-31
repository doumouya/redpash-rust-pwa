---
title: backend/crates/api/src/routes/members.rs
source: ../../../../../../backend/crates/api/src/routes/members.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# members.rs

## Purpose

Generic **object-member management** — CRUD on the polymorphic `memberships`
edge for **any** object entity (company / project / case / team). One
implementation: each object type just `nest`s `routes()` under its
`/:rid/members` path. The membership row IS both the access-control check and
the org graph, so this module is the single home for "who can be added to what,
and by whom".

This is the natural payoff of the entity-membership model: because the edge is
`(object_redpash_id, member_redpash_id, role, context_role)` over `entities`,
the *same* handler manages a company's roster, a project's members, a case's
team, and a team's roster — and a `member` may itself be a team (team-as-grantee).
It relates to the **object-entity membership**, not a separate "team membership"
concept; a team's roster is simply this edge with `object = a team`.

## Routes (relative — nested under e.g. `/api/companies/:rid/members`)

| Method · Path        | Gate                              | Action                    |
|----------------------|-----------------------------------|---------------------------|
| `GET /`              | any member (or platform admin)    | list the object's members |
| `POST /`             | owner/admin on the object         | add a member (upsert)     |
| `PATCH /:member_id`  | owner/admin on the object         | change a member's role    |
| `DELETE /:member_id` | owner/admin **or** `@own` (leave) | remove a member           |

## Public surface

- `pub fn routes` — the generic member router; nest it under any object type's
  `/:rid/members`. Axum carries the parent `:rid` into the handlers
  (`Path<String>` for list/add, `Path<(String, String)>` for patch/remove).
- `pub(crate) async fn require_member` — resolve the caller's **direct** role on
  the object (platform admin → `owner`), 404ing when they aren't a member
  (leak-free). Also used by `companies::get_one` as the company read gate.

## Shared rules (apply to every object type)

- **Roles** `owner > admin > member`; the manage gate is direct owner/admin on
  the object (not the cascade resolver — managing X's roster means being
  owner/admin *of X*).
- Only an **owner** may grant the `owner` role.
- The **last owner** can't be demoted or removed (promote/transfer first).
- An **admin** can't remove an **owner**.
- **Self-leave**: a member may `DELETE` their own membership without manage.
- Event kinds stay object-typed via `object_type()` —
  `company_member_add`, `project_member_add`, … (the `entities.type` lookup).

## Drift-prone areas

- The DB helpers (`db::company_role`, `db::list_company_members`,
  `db::add_company_member`, `db::update_company_member_role`,
  `db::remove_company_member`, `db::company_owner_count`) are **object-agnostic**
  — they key on `object_redpash_id`; the legacy `company_` naming is cosmetic.
  A rename to `object_*` would touch every caller — deferred.
- Wiring a new object type onto member-management is just
  `.nest("/:rid/members", super::members::routes())` in that object's router —
  no per-object handler. This activates the resolver write-gates that assume
  member-management exists.

## Related

- [companies.rs](companies.md) — first object migrated onto this module.
- [rbac.rs](../rbac.md) — the effective-access resolver the write-gates use.
- [membership spec](../../../specs/rbac/membership.md) — the entity-edge policy.
- [Backend pillar landing](../../index.md)
