---
title: RBAC — memberships
section: Internal
last modified date: 2026-06-07
---

# RBAC — memberships

A membership is one self-referential **edge** in the `memberships` table:
`(object_redpash_id, member_redpash_id, role, context_role)`. Both ends are
entities — the `object` is the thing the role is *on* (a company, project,
case, or team) and the `member` is the principal that holds it (a user **or**
a team). This one polymorphic row replaces the per-object join tables a
Salesforce-shaped schema would grow (`CompanyMember`, `ProjectMember`,
`CaseTeamMember`, `TeamMember`, …): there is no `case_team` table, no
`project_members` table — there is the membership edge, discriminated by the
object's entity type.

## Why one edge

The whole authorization graph is this edge plus its transitive closure. Three
things fall out of making both ends entities rather than baking "user → object"
into a typed column:

- **Teams as grantees.** Because `member` can be a team, "give the Support team
  write on every case" is a single edge `(object=company, member=TEM_support,
  role)`. The resolver flows that grant to every Support member through the same
  cascade that gives a company-admin reach — no per-team policy code.
- **Nested teams / departments.** Because the `member` can itself be a team,
  `(object=General Eng, member=Platform Eng)` makes Platform Eng a sub-team. The
  resolver's recursive principal closure climbs `member → object`, so a
  Platform Eng person inherits General Eng's grants (downward only).
- **Case Team Members are just memberships.** Case collaborators are
  `(object=CAS_…, member=<user|team>, role, context_role)` edges. The role tier
  is the access level (viewer = read, member+ = write); `context_role` is the
  free-text business label ("Reporter", "Case Owner"). The widened composite key
  lets one person hold two edges (reporter *and* assignee) and a case have
  co-reporters. The UI says "Case Team Member"; the backend stores a membership.

The columns: `role` is the permission **tier** with a CHECK of
`owner · admin · member · viewer`; `context_role` is the business label.
There is no `redpash_id` on a membership — its identity *is* the composite key,
so it is never URL-addressable alone. Every operation routes through the parent
object (`/api/companies/:rid/members`, …). Joining is what makes the scope
qualifiers (`@company`, `@project`, a case team) real: every other object's
scoped grant is *defined by* the existence of a membership row, which is why
this is the meta-object of RBAC.

## One generic CRUD module, nested per object type

There is a single implementation in `routes/members.rs`. Each object type's
router `nest`s the same `routes()` under its own `/:rid/members` path; the four
handlers (list / add / patch-role / remove) are object-agnostic. The DB helpers
(`db::company_role`, `db::list_company_members`, `db::add_company_member`, …)
key on `object_redpash_id` — the `company_` naming is cosmetic legacy, not a
table binding.

- **GET /** — list the roster. Read gate is `require_member`, which defers to
  the RBAC resolver (`require_view`): the caller needs an effective role on the
  object (a direct membership, a role via the company/project cascade, or a
  team they belong to), else a leak-free 404. The same helper backs
  `companies::get_one`.
- **POST /** — add a member. Gated by `manage_tier`.
- **PATCH /:member_id** — change a member's role. Gated by `manage_tier`.
- **DELETE /:member_id** — remove a member, or self-leave.

## The manage gate is reach-aware (this is the load-bearing detail)

`manage_tier` resolves the caller's **effective** role on the object — not just
a direct membership — and requires `Admin`+ (platform admins short-circuit to
`Owner`). This is what lets a company/project admin manage a *case* team: case
memberships are all `member`-tier, so a direct-only gate would deny everyone;
the cascade supplies the authority. It distinguishes 404 (no reach at all,
leak-free) from 403 (a member who has reach but lacks the manage tier), and
returns the caller's tier so the owner-grant rule can check it.

Roster bookkeeping guards — last-owner, demotion — stay **direct** on the
object (`db::company_role`, `db::company_owner_count`), because those are about
the rows physically on this object, not the caller's inherited reach.

## Invariants enforced on write

- **Role must be `owner | admin | member`** on add/patch (the `viewer` tier
  exists in the CHECK but isn't granted through these routes).
- **Only an owner grants `owner`.** An admin can add and manage members but
  can't mint a co-owner. A sub-rule of the grant, gated on the tier
  `manage_tier` returned.
- **Last-owner guard.** Can't demote (add-as-lesser, patch) or remove the last
  owner of a scope — 400/403 regardless of grant. Re-adding an existing owner
  with a lesser role is treated as a demotion and runs the same check. Admins
  also can't remove an owner; only an owner-tier caller can.
- **Members must be users or teams.** The grantee's entity `type` is checked;
  a company/project/case as member is rejected (400), a missing rid is 404 —
  clean errors instead of an FK 500.
- **Cross-tenant team guard.** A team is company-scoped, so granting one a role
  injects its whole transitive membership into the object's graph. The team
  must belong to the **same company** as the object; otherwise a leak-free 404
  (a foreign-tenant team is indistinguishable from a missing one). Users are
  global multi-tenant principals, so this scoping is team-only.
- **Team-cycle guard.** Before adding a team as a member, `principals(object)`
  climbs the team graph; if the new team already contains the object (or is the
  object), adding it would close a cycle (A ⊂ B ⊂ A) — 409. The UNION-deduped
  closure is cycle-safe regardless; this is the clean front-door error.
- **One direct department per member per company.** When the object is a
  `kind='department'` team, the member can't already hold a different department
  in that company — 409 (`one_department`). This mirrors the
  `enforce_one_department_per_user` DB trigger (which keys on the member
  generically, covering users and teams), surfaced as a clean 409 instead of
  the trigger's raised-exception 500; the advisory-locked trigger stays the
  race-safe backstop. Departments still nest freely (a member transitively
  belongs to ancestor departments); only a second *direct* department is barred.

## Object-typed audit events

Each mutation emits an event keyed by the object's entity type:
`{company|project|case|team}_member_add`, `_member_role_change`, and the
self-leave vs admin-remove split — `_member_leave` (info) when the caller drops
their own row, `_member_remove` (warn) when they remove someone else. Both hit
the same DELETE route; the actor-vs-target check picks the branch.

## Source files

- [`code/backend/api/routes/members.md`](../../code/backend/api/routes/members.md) — the generic member-CRUD module (the four handlers + every invariant above).
- [`code/backend/api/rbac.md`](../../code/backend/api/rbac.md) — the resolver: `resolve_grant`, `require_view`, `is_platform_admin`, the principal closure, and the `Role` tier ordering the gates lean on.
- [`code/backend/api/db/mod.md`](../../code/backend/api/db/mod.md) — the object-agnostic membership query layer (`company_role`, `list_company_members`, `add_company_member`, `company_owner_count`, …).
