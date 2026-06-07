---
title: RBAC — the entity ↔ membership model
section: Internal
last modified date: 2026-06-07
---

# RBAC — the entity ↔ membership model

Every authorization question in RedPash reduces to **one self-referential
edge**: a *principal* (an entity) holds a *role* on an *object* (an entity).
That is the whole spine. Companies, projects, cases, and teams are entities;
**users are entities too**. The `memberships` table is just an edge between two
entities carrying a role — and because both ends are entities, the same one
table and the same one resolver answer "can X do Y to Z?" for every object type
that exists today and every object type we add later.

This is the keystone of [[disposability-design-principle]] and the
[[beat-salesforce-lean-model]] north-star: instead of one access table per
object (Salesforce's CaseTeamMember, AccountTeamMember, OpportunityTeamMember…
each with its own AccessLevel plumbing), RedPash has **one polymorphic
Membership**. A new object hangs members off it for free.

## Entities — the supertype

`entities` is the registry of "things that can participate in the access
graph". Its `type` CHECK admits `user · company · project · case · team`. Two
facts make the model work:

- **Objects are entities.** A company, project, case, or team has a row in
  `entities`, so it can be the *object* end of a membership edge — the thing a
  role is held *on*.
- **Subjects are entities.** Users rejoined the supertype (the implemented
  schema originally dropped `'user'`; it was added back), so a user can be the
  *member* end. Crucially, so can a **team** — a team is an entity, so it can
  hold a role just like a user. That single fact is what lets "give the HR team
  access to this project" be an ordinary edge instead of a hardcoded business
  rule.

The RID prefix (`CMP_`, `PRJ_`, `CAS_`, `TEM_`, `USR_`) is how the object's
type is recognized at the edges; the canonical `type` lives in `entities`.

## The membership edge

`memberships` is the edge. Its load-bearing columns:

- **`object_redpash_id`** → any entity. *What* the role is on.
- **`member_redpash_id`** → any entity, user **or** team. *Who* holds it.
- **`role`** — the permission tier, `owner · admin · member · viewer`. This is
  what the resolver reads.
- **`context_role`** — a free-text human label ("CEO", "Reporter", "Data
  Analyst"). **Display only.** No enforcement path reads it; never let it
  override `role`. `''` means no label.

The primary key is `(object, member, role, context_role)` — wide on purpose. A
principal can hold **many roles on the same object** (owner *and* a "Reporter"
context label; reporter *and* assignee). The old `(object, user)` single-role
key is gone — "moving a membership = delete + create" no longer holds; you
add/remove specific edges.

`memberships` simultaneously **is** the access-control layer **and** the org
graph: `user → team` edges are how you say "Dave is in HR"; `team → team` edges
are nesting (a sub-team is a team that is a *member* of a parent team); `team →
company` is "the HR team has a role on this company". No separate org table.

### How any object hangs members off it

Member management is one generic implementation (`routes/members.rs`) that every
object type `nest`s under `/:rid/members`. Companies, projects, cases, and teams
all route through it — the DB helpers key on `object_redpash_id`, so the legacy
`company_*` naming in `db::add_company_member` / `db::company_role` is cosmetic;
they work for any object. List / add / change-role / remove (or self-leave) are
identical regardless of which kind of object the `:rid` points at.

A "manager" of the roster is an owner/admin **directly on the object** *or* one
who reaches `admin`+ through the cascade *or* a platform admin. That cascade
matters: a case's memberships are all `member`-tier collaborators, so a
direct-only gate would let nobody manage a case team — the company/project admin
supplies the authority via the cascade (`manage_tier`).

## Auto-grant on create

Creating an object is one transaction that also writes the creator's edge —
there is no object without an owner:

- create Company / Project / Team / Case → `(object, creator, owner, '…')`.
- report a Case → `(case, reporter, member, 'Reporter')` — **member, not
  viewer**, so the reporter can comment on their own case (commenting is a
  write at `member`+). The edge *is* the grant: an HR person with no
  case-bearing edge can't see other cases (default-deny), but filing one mints
  their `member` edge on *that* case and they can now see and comment on it.

## The resolver — one query, every gate

A principal's **effective role** on an object is the **highest** role found
across three unioned sources, in a single recursive query (`rbac.rs`,
`GRANT_SQL`):

1. **direct** — a membership edge on the object itself (own reach).
2. **cascade** — a membership on the object's scope: a case's company *or*
   project, a project's company, a project_file's project→company chain, and a
   custom object's `entity_data.scope_parent_id`. (The cascade has grown past
   the original cases/projects spec to cover files and registry objects — follow
   the code, `GRANT_SQL`, for the current scope set.)
3. **team** — every team the principal belongs to, **recursively**, so nested
   teams close. The `principals` CTE climbs `user → team → parent-team` and the
   grants of any team in that closure flow down.

`max(rank)` *is* "highest role wins". A `Grant` is split by reach
(`direct` / `scope`) because write gates need the distinction: a case reporter
and a bare company member are both `member` tier, but only the reporter holds
the object directly. `Grant::effective()` is the higher of the two; `None` means
no edge reaches the object anywhere → **default-deny**.

The resolver is encoded **once**. Handlers never re-implement membership joins —
they call `require_view` (any reach) or `require_grant` with a small rule
closure (`case.delete → |g| g.scope_at_least(Admin)`). Denial returns **404,
not 403** — a caller who can't reach an object can't distinguish "exists but not
yours" from "doesn't exist" (leak-free, matching the old `ensure_owner`
contract).

### Platform admin bypass

`is_platform_admin` short-circuits every gate: the bootstrap `dev_user`
(fast-path, no query — keeps dev mode permissive) and any `users.role = 'admin'`.
This is the catalog's `*.view.all`.

## The two axes: tier (vertical) × contract (horizontal)

The tier ladder above is the **vertical** axis — *how much* authority a
principal has on an object's subtree. There is now a **horizontal** axis too:
the per-company `Contract` (JSONB in `company_rbac`, active = highest version).
It answers *which object TYPES* a team may act on — "Engineering owns Cases +
Monitoring; HR owns Users + Payslips" — as a per-`(team, object-type)` set of
CRUD letters. This is capability, not rank: it's keyed on team **PKs** and
object **types**, never on a team/department *name*.

`require_action` is the convergence gate that reads both: `is_platform_admin`
bypasses (RedPash root); a company_owner gets its whole subtree; otherwise the
tier (from `resolve_grant`) **and** the contract's grant must both pass.
Critically the rollout is **non-breaking**: a company with no registered
contract evaluates **tier-only** (today's behaviour), so the horizontal axis
adds restriction only where a company opts in. company_admin is fail-closed —
it gets org-management, not automatic content CRUD.

## Deletion — Scrub & Retain

Deleting a user never touches its membership edges. The edges *are* the audit
trail and the "Deleted User" anchor: a deleted reporter must still resolve as
the case's reporter. Deletion tombstones the user's PII in place
(`display_name = 'Deleted User'`, `status = 'archived'`), revokes sessions, and
emits an `owner_vacancy` event where the archived user was the sole owner of an
object — never blocks, never silently orphans, never hard-deletes. Member
pickers filter on `status = 'active'`; display-name JOINs render archived
principals as "Deleted User".

## Why this shape

One edge, one resolver, no special-cased FK, no "business rule" branch:

- a **team can be granted a role** — it's an entity on the subject end;
- a principal can hold **many roles per object** — the wide PK;
- team **nesting** is free — `team → team` edges + the recursive closure.

These are not three features; they are all "the subject is an entity." Add a new
object type, register it in `entities`, nest `routes::members::routes()` under
it, and it has a full member model and full RBAC the day it ships.

## Source files

- [`../../code/backend/api/rbac.md`](../../code/backend/api/rbac.md) — the
  effective-access resolver (`Role`, `Grant`, `resolve_grant`, `require_grant` /
  `require_view`, the `Contract` horizontal axis, `require_action`).
- [`../../code/backend/api/routes/members.md`](../../code/backend/api/routes/members.md)
  — the generic member-management routes shared by every object type.
- [`../../code/backend/api/routes/companies.md`](../../code/backend/api/routes/companies.md)
  — company creation + auto-grant; mounts the member routes.
- [`../../code/backend/api/routes/cases.md`](../../code/backend/api/routes/cases.md)
  — the reporter `member` edge + case-team reach.
- [`../../code/backend/api/routes/teams.md`](../../code/backend/api/routes/teams.md)
  — teams as subjects, nesting, and the department invariant.
