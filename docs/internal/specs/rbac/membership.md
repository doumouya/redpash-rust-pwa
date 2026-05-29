---
title: Membership — permission catalog
section: Internal
order: 59
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md)); polymorphic company/project/case model per Em 2026-05-29
---

# Membership — permissions

Permission keys + default grant matrix for the **polymorphic
Membership object** — one abstraction spanning company / project /
case scopes (per Em 2026-05-29, the [index](index.md#case-team-member--membership-extends-to-case-instances)
Case Team Member note). A membership is `(scope_type, scope_id, user,
role)`:

| scope_type | Backing | UI label | role enum |
|---|---|---|---|
| `company` | `company_memberships` | Member | owner · admin · member |
| `project` | `project_memberships` (v3) | Member | owner · collaborator · viewer |
| `case` | (v3 — case team) | **Case Team Member** | per AccessLevel: read · write |

Modeled on Salesforce's `CaseTeamMember` (a user linked to a record
with a role whose *AccessLevel* governs the record access). In RedPash
the role's tier IS the access level — a membership's role is what the
other objects' grant matrices read when they resolve `@company` /
`@project` / case-team scope. **Membership is the join that makes the
scope qualifiers real.**

Derived from [membership metadata](../object-metadata/membership.md);
scheme in the [catalog template](index.md).

**Scope columns:** `scope_id` (the parent company/project/case) → the
membership is scoped to that parent; `user_redpash_id` → `@own` (your
own membership, for self-leave). No `redpash_id` (composite identity);
never URL-addressable alone — every op routes through the parent
(`/api/companies/:rid/members`, eventually `/projects/:rid/members` +
`/cases/:rid/team`).

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `membership.create` | `POST /api/{companies\|projects\|cases}/:rid/members` | (parent-scoped) | Add a member to a company/project/case. Owner-only for granting the `owner` role. |
| `membership.read` | (via parent's members list) | (parent-scoped) | Not individually addressable; surfaces on the parent's members list + `UserProfile.memberships[]`. |
| `membership.update` | `PATCH …/members/:user_id` | (parent-scoped) | Role change. Owner-only for promoting to `owner`. Last-owner demotion blocked. |
| `membership.delete` | `DELETE …/members/:user_id` | own · (parent-scoped) | **Self-leave** (`@own`) OR **admin-remove** (parent owner/admin). Last-owner removal blocked. |
| `membership.list` | `GET …/members` + admin cross-scope | (parent-scoped) · all | Per-parent members list; admin `?scope=` cross-scope paginated list. |
| `membership.role.update` | `role` field | (parent-scoped) | The only mutable field — same grant as `membership.update`; owner-only to set `owner`. |

**No keys for:** `scope_id` / `user_redpash_id` (composite PK, set at
create, never re-pointed — moving a membership = delete + create),
`joined_at` (server-set, not bumped on role change).

---

## 2. Grant matrix

Columns are the caller's role **in the parent scope** being acted on.
`@own` = the membership is the caller's own (self-leave). For
`project`/`case` scopes the owner/admin columns map to
collaborator/write-tier equivalents (v3).

| Key | plat:admin | parent:owner | parent:admin | parent:member | @own |
|---|---|---|---|---|---|
| `membership.create` | all | scope | scope | — | — |
| `membership.read` | all | scope | scope | scope | own |
| `membership.list` | all | scope | scope | scope | own |
| `membership.update` | all | scope | scope | — | — |
| `membership.delete` | all | scope | scope | — | own |
| `membership.role.update` | all | scope | scope | — | — |

Reading it: a parent owner/admin manages its members (add / list /
role-change / remove); any member can read the roster + leave on their
own (`@own` delete); promoting someone to `owner` is owner-only (a
narrower rule inside `membership.role.update` — see Notes); the last
owner can't be demoted or removed (guard, see Notes).

---

## 3. Notes

- **Membership is the scope resolver.** Every other object's
  `@company` / `@project` / case-team grant is *defined by* a
  Membership row: "`case.read@company`" means "there's a
  `company`-scope Membership linking the caller to the case's company."
  So this object's matrix governs who can grant *others* the scopes
  the rest of the catalog leans on — it's the meta-object of RBAC.

- **Case Team Member = case-scope Membership.** Per Em's 2026-05-29
  call, case collaborators aren't a new table — they're
  `(scope_type=case, scope_id=CAS_…, user, role)` rows. The role's
  access level (read vs write) is what Case's matrix resolves when it
  grants beyond reporter/assignee `@own`. The UI labels them "Case
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

- **Today: company only.** `project_memberships` is schema-only and
  case-team is v3 — so the live grants bind `company` scope alone. The
  project + case rows of this matrix are the RBAC-v3 target.
