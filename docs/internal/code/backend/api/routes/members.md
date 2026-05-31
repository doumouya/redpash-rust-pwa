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

Nested on **all five** object types: `companies`, `projects`, `cases`,
`teams` (and itself reusable for any future entity) — each is just
`.nest("/:rid/members", super::members::routes())` in that object's router.

## Routes (relative — nested under e.g. `/api/companies/:rid/members`)

| Method · Path        | Gate                                       | Action                    |
|----------------------|--------------------------------------------|---------------------------|
| `GET /`              | any effective role (any reach) · platform  | list the object's members |
| `POST /`             | effective `Admin`+ (direct **or** scope)   | add a member (upsert)     |
| `PATCH /:member_id`  | effective `Admin`+                         | change a member's role    |
| `DELETE /:member_id` | effective `Admin`+ **or** `@own` (leave)   | remove a member           |

## Public surface

- `pub fn routes` — the generic member router; nest it under any object type's
  `/:rid/members`. Axum carries the parent `:rid` into the handlers
  (`Path<String>` for list/add, `Path<(String, String)>` for patch/remove).
  **Signature is parameterless on purpose** — every object shares one manage
  policy, so adding an object type never edits this module.
- `pub(crate) async fn require_member` — the **read** gate: `rbac::require_view`
  (any effective role at any reach, or platform admin; leak-free 404). Also
  reused by `companies::get_one`.
- `manage_tier` (private) — the **reach-aware manage** gate. Returns the
  caller's effective tier when they hold `Admin`+ on the object via *any* reach
  (direct, or company/project cascade, or team), or are a platform admin;
  `None` reach → 404, member-but-not-admin → 403.

## Shared rules (apply to every object type)

- **Roles** `owner > admin > member > viewer`. The manage gate is **reach-aware**
  (`resolve_grant().effective() >= Admin`) — *not* direct-only. This is required
  for correctness across object types: a **case**'s memberships are all
  `member`-tier (+`context_role`), so a direct-only gate would deny everyone but
  a platform admin; the cascade lets the project/company admin manage the case
  team. For `company`/`project`/`team` the behaviour is unchanged for direct
  owners/admins — scope simply *adds* the correct parent-admin reach.
- Only an **owner**-tier caller (effective) may grant the `owner` role.
- The **last owner** can't be demoted or removed (promote/transfer first).
- An **admin** can't remove an **owner**.
- A **member (grantee) is a user OR a team** — `add` validates the entity type
  and 400s a company/project/case (they're objects, not grantees), 404s a
  missing rid. A team-as-member is a **sub-team** (Platform Eng ⊂ General Eng);
  the resolver's recursive principal closure flows the parent's grants down to
  sub-team members. Adding a team runs two guards:
  - **cross-tenant** — the team's `company_id` must match the object's
    resolving company (company / project / case / team), else leak-free 404. A
    team carries transitive members, so a foreign-company team would inject
    another tenant into this object's graph (IDOR). Users are **not** scoped —
    they're global multi-tenant principals (company invite adds them by id).
  - **cycle** — reject if the new team is already in `principals(object)`
    (would close A ⊂ B ⊂ A). Users never trip either guard.
- **Department invariant** — when the *object* is a `kind='department'` team,
  the member can't already hold a different department in that company → clean
  409 (`one_department`). For a user that's "one home department"; for a team
  it keeps the department tree single-parent. Departments nest freely
  otherwise (transitive ancestors are intended). Mirrors the
  `enforce_one_department_per_user` DB trigger (the race-safe backstop). See
  [membership spec](../../../specs/rbac/membership.md) "Department nesting".
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
