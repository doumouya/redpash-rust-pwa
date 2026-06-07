---
title: RBAC — teams
section: Internal
last modified date: 2026-06-07
---

# RBAC — teams

A **team** (`TEM_`) is a company-scoped subgroup of users. It is two
things at once, and keeping them separate is the key to understanding
the model:

1. A **row** — a record under a parent company, with its own CRUD
   gates (who can rename it, who can delete it). This is the "team as
   object" side.
2. A **grant-bearing principal** — when a team is seated on some other
   object (a project, a case, a file), every member of the team
   inherits the team's grants on that object. This is the "team as
   subject" side, and it is a property of the
   [RBAC resolver](../../code/backend/api/rbac.md), not of any team
   permission atom.

The same polymorphic [`memberships`](memberships.md) edge that links
users to companies, projects, and cases also links users to teams. A
team membership is therefore an ordinary `memberships` row whose
`object_redpash_id` is a `TEM_` rid — there is no bespoke join table.
That is why `routes/members.rs` mounts unchanged under
`/api/teams/:rid/members`: the member-CRUD layer keys on
`object_redpash_id`, never a typed column.

## How a team composes with the entity-membership model

The [entity-membership model](entity.md) gives every object two reach
axes — `own` (you hold a direct membership) and a cascade from a
parent. For a team the parent is its **company** (`teams.company_id`
is `NOT NULL`), so a team supports three reaches:

- **own** — the caller holds a direct membership on the team itself.
- **company** — the caller's reach cascades from the team's parent
  company; a company admin manages every one of its teams' rosters and
  metadata without ever being a direct team member.
- **all** — platform admin.

The role spine inside a team is the standard `owner > admin > member`.
Only an owner can mint another owner, and the last owner can't be
removed or demoted — those guards live in `routes/members.rs` and fire
on `db::company_owner_count` (object-agnostic despite the legacy name).

### Two cascades, one team

Note the two distinct cascade directions a team participates in, and
don't conflate them:

- **Down-cascade (team as object):** a company admin reaches *into* the
  team to manage its row and roster. This is the company → team reach
  used by the route guards.
- **Up-inheritance (team as principal):** a team member inherits grants
  the team holds on *other* objects. This is closed recursively by
  `rbac::caller_principals` (a recursive CTE over team memberships) and
  has nothing to do with the team's own permission catalog.

A user being seated on a team does not grant `team.view` on the team
"by inheritance" — the membership row grants that directly. The
recursive closure only matters for objects the team is seated on
elsewhere.

## What the routes actually enforce

The `/api/teams` router (`routes/teams.rs`) wires CRUD plus the nested
member layer. The gates as they stand in code today:

- **List** (`GET /api/teams`) — *scoped, not global*. Platform admins
  pass `viewer = None` and get every team; everyone else passes their
  own rid and gets only teams they're in directly or via a company they
  belong to. (The global admin directory rides a separate
  `team.view.all` route, the Home Teams tab.)
- **Read one** (`GET /api/teams/:rid`) — `require_member`: any direct
  team member (or cascade-equivalent) can read the whole record.
- **Create** (`POST /api/teams`) — *parent-company-gated*. The handler
  runs `rbac::require_grant(company_id, effective.is_some())`, so any
  caller who reaches the parent company at **member or higher** can
  plant a team, and is seated `owner` in the same transaction. An
  outsider gets `404 not_found` (leak-free), and a non-existent
  `company_id` is caught as an FK violation (`23503`) and remapped to
  404 rather than a 500. Platform admin bypasses via the resolver.
- **Patch** (`PATCH /api/teams/:rid`) — team **admin+** (direct role)
  or platform admin. Only `name` is mutable through this endpoint.
- **Delete** (`DELETE /api/teams/:rid`) — team **owner only** (direct
  owner) or platform admin. Deleting a team CASCADEs the membership
  rows where the team is the object — and, because those rows were also
  the edges carrying the team's inherited grants, a deletion is also a
  revocation of the team's access everywhere it was seated.

Every gate denies with `404` rather than `403` so a caller can't probe
for the existence of teams they can't see.

### The `kind` field: team vs department

`create` also accepts `kind` ∈ `{team, department}` (default `team`).
The schema CHECK already restricts the set; the handler revalidates so
the FE gets a clean `400` instead of a `500` from constraint code
`23514`. Departments carry extra invariants (single-parent,
one-direct-department-per-user) enforced downstream by
`enforce_one_department_per_user` and the member layer — those live
with the membership rules, not the team row gates.

### Intentionally absent

There is **no** `company_id` update path. Moving a team across
companies would change its inherited grants on every object the team is
seated on — a cross-object transfer, not a sparse PATCH. The current
PATCH endpoint does not expose it.

## Where the rest of the rules live

Adding, removing, and role-changing team members mutate team-scope
[`memberships`](memberships.md) rows, so those atoms
(`membership.create@team`, role-change, last-owner guard) are
documented on the membership side, served by the shared
`routes/members.rs` module. Team's own gates — covered above — are only
about the team row itself.

## Source files

- [`code/backend/api/routes/teams.md`](../../code/backend/api/routes/teams.md) — the `/api/teams` CRUD handlers and the parent-company create gate.
- [`code/backend/api/routes/members.md`](../../code/backend/api/routes/members.md) — the shared polymorphic member-CRUD layer mounted under `/:rid/members`.
- [`code/backend/api/rbac.md`](../../code/backend/api/rbac.md) — `require_grant`, reach resolution, and the `caller_principals` team-as-principal closure.
- [`code/backend/shared/team.md`](../../code/backend/shared/team.md) — the `Team` / `TeamSummary` wire shapes.
