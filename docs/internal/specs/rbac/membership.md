---
title: Membership — permission catalog
section: Internal
order: 59
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — reconciled to the entity-membership model (migrations 20260531000000/…001); the generic member-CRUD module (routes/members.rs) is live on all 5 object types (/:rid/members) with a reach-aware manage gate (effective>=Admin); per-object matrices are the policy layer over the [entity-membership-model](entity-membership-model.md) §2 resolver
---

# Membership — permissions

Permission keys + default grant matrix for the **polymorphic
Membership object** — one abstraction spanning company / project /
case / team scopes. The data-model foundation is
[entity-membership-model](entity-membership-model.md) (shipped,
migrations `20260531000000`/`…001`); **this file is the policy layer
that reads it.**

A membership is a single self-referential **edge**:
`(object_redpash_id, member_redpash_id, role, context_role)` where
**both `object` and `member` are entities** — so a grant's subject can
be a user *or a team*, and one principal holds as many role-edges as
the org gives it (owner+admin, reporter+assignee). `role` CHECK =
`owner · admin · member · viewer` (the permission tier); `context_role`
is the free-text business label ('Reporter', 'Case Owner', 'CEO', …).
All scopes are the ONE `memberships` table, discriminated by the
object's entity type:

| object type | Backing | UI label | roles |
|---|---|---|---|
| `company` | `memberships` | Member | owner · admin · member · viewer |
| `project` | `memberships` | Member | owner (live) · admin/member/viewer |
| `case` | `memberships` (case-object rows) | **Case Team Member** | tier = access level; `context_role` = Reporter / Case Owner (co-reporters allowed) |
| `team` | `memberships` (team-object rows) | Team / Department Member | owner · admin · member; a team can also be the **grantee** on another object |

Modeled on Salesforce's `CaseTeamMember` (a principal linked to a
record with a role whose *AccessLevel* governs record access), but
generalized: in RedPash the role's tier IS the access level, the
principal can be a team, and a caller's **effective** role on an object
is the *highest* of their direct grant ∪ scope cascade (the object's
company/project) ∪ team-closure — resolved by the one query in
[entity-membership-model §2](entity-membership-model.md). The grant
matrix below reads that resolved role. **Membership is the join that
makes the scope qualifiers real.**

Derived from [membership metadata](../object-metadata/membership.md);
scheme in the [catalog template](index.md).

**Columns:** `object_redpash_id` (the entity the role is *on* —
company/project/case/team) scopes the membership to that parent;
`member_redpash_id` (the holder entity — a user or a team) → `@own`
when it's the caller (self-leave). No `redpash_id` — the identity is
the composite key; never URL-addressable alone — every op routes
through the parent (`/api/companies/:rid/members`, eventually
`/projects/:rid/members` + `/cases/:rid/team`).

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. A membership isn't individually addressable —
its view is the *parent's roster*, so `membership.view` reaches the
parent scope; `read`/`list` are both this one `view` (the reach decides
*which* memberships the roster returns). Membership has no per-field
allow-list to speak of — the only mutable field is `role` — so
`membership.role.update` **is** the field-update atom.

### View atom

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `membership.view` | the members of a scope (the parent's roster + `UserProfile.memberships[]`) | (parent scope) · all | `read`/`list` both gate on this; not individually addressable — surfaces only via `GET …/members` + the admin `?scope=` cross-scope list. Reach = the parent the membership is *on*. |

### Write atoms (derive from `membership.view`)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `membership.create` | `membership.view` (+ a manage grant) | (parent scope) | `POST /api/{companies\|projects\|cases}/:rid/members` — add a member to a company/project/case. Owner-only for granting the `owner` role (see Notes). |
| `membership.role.update` | `membership.view` | (parent scope) | `PATCH …/members/:user_id` — `role` is the only mutable field, so this **is** the field-update atom. Owner-only for promoting to `owner`; last-owner demotion blocked. |
| `membership.delete` | `membership.view` | own · (parent scope) | `DELETE …/members/:user_id` — **self-leave** (`@own`) OR **admin-remove** (parent owner/admin). Last-owner removal blocked. |

**No atoms for:** `object_redpash_id` / `member_redpash_id` / `role` /
`context_role` (the composite PK `(object, member, role, context_role)`,
set at create — a principal holds many edges, so changing a tier is
replace-the-tier-row, not re-point), `joined_at` (server-set, not
bumped on role change).

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns are the caller's role bundle **in the parent
scope** being acted on: platform `admin`; the parent bundles
`owner`/`admin`/`member`; and `@own` — the membership is the caller's
own (self-leave). Membership ops are parent-scoped — `scope` = the
parent company/project/case the caller manages. For `project`/`case`
scopes the owner/admin columns map to collaborator/write-tier
equivalents (v3). Wider reach wins on union.

| Atom | plat:admin | parent:owner | parent:admin | parent:member | @own |
|---|---|---|---|---|---|
| `membership.view` | all | scope | scope | scope | own |
| `membership.create` | all | scope | scope | — | — |
| `membership.role.update` | all | scope | scope | — | — |
| `membership.delete` | all | scope | scope | — | own |

Reading it: a parent owner/admin manages its members (add / view roster
/ role-change / remove); any member can view the roster + leave on their
own (`@own` delete); promoting someone to `owner` is owner-only (a
narrower rule inside `membership.create` + `membership.role.update` —
see Notes); the last owner can't be demoted or removed (guard, see
Notes).

---

## 3. Notes

- **Membership is the scope resolver.** Every other object's
  `@company` / `@project` / case-team grant is *defined by* a
  Membership row: "`case.view@company`" means "there's a
  `company`-scope Membership linking the caller to the case's company."
  So this object's matrix governs who can grant *others* the scopes
  the rest of the catalog leans on — it's the meta-object of RBAC.

- **Teams as grantees + departments.** Because `member` is an entity, a
  *team* can hold a role on an object — "give the Support team write on
  every case" is one edge `(object=company, member=TEM_support, role)`,
  resolved through the same cascade as a company-admin (no policy code).
  A user's department is a `kind='department'` team they belong to; the
  `enforce_one_department_per_user` trigger caps that at one per company
  (multiple ad-hoc teams are fine). See
  [entity-membership-model](entity-membership-model.md) §1–§2.

- **Case Team Member = case-object Membership.** Case collaborators
  aren't a new table — they're `(object=CAS_…, member=<user|team>,
  role, context_role)` edges. `context_role` carries the business label
  ('Reporter' / 'Case Owner'), and the widened key means one person can
  hold *both* (reporter + assignee) and a case can have co-reporters.
  The role tier (viewer=read / member+=write) is what Case's matrix
  resolves beyond reporter/assignee `@own`. The UI labels them "Case
  Team Members"; the backend treats them as Memberships. v3 wires the
  `/cases/:rid/team` endpoints mirroring the company member routes.

- **Owner-only for granting owner.** Inside `membership.create` +
  `membership.role.update`, setting `role = owner` is gated to a
  current owner (or platform admin) — an admin can add/manage members
  but can't mint a co-owner. Sub-rule of the grant, not a separate key.

- **Last-owner guard.** Can't demote or remove the last `owner` of a
  scope (`db::company_owner_count` today; mirrors to project/case in
  v3). A structural guard — returns 400 regardless of grant — not a
  permission.

- **Self-leave vs admin-remove split.** `membership.delete@own` is
  "leave this company/project/case"; the parent-owner/admin scope is
  "remove someone else." Both hit the same DELETE route; the actor-vs-
  target check picks the branch (emits `*_member_leave` vs
  `*_member_remove` events accordingly).

- **Today: company member-management + project ownership.** All scopes
  share the one `memberships` table; project ownership rows live there
  now (a `role='owner'` row written on project create, read by the
  owner gate). What's not yet wired is the public member-management
  routes for project + case scope (add/remove/role-change) — those are
  the RBAC target. Company scope already has the full member-management
  surface.
