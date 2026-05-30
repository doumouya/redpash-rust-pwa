---
title: Membership — object metadata
section: Internal
order: 49
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Membership (`memberships`)

A user's role within an entity — a Company, a Project, or a Case.
**One polymorphic table**, `memberships`, backs every scope: the
parent is referenced by a single `object_redpash_id` FK →
`entities.id`, and the joined parent type (company vs project vs case)
discriminates the scope. A pure join table: composite PK on
`(object_redpash_id, user_redpash_id)`, no `redpash_id`, never
URL-addressable on its own — every membership operation routes through
the parent (`/api/companies/:rid/members` or, eventually,
`/api/projects/:rid/members`).

**Backing table:**
- `memberships` (unified baseline `20260529000000_init.sql`) — PK
  `(object_redpash_id, user_redpash_id)`, FK `object_redpash_id →
  entities.id ON DELETE CASCADE`. Replaces the former parallel
  `company_memberships` + `project_memberships` tables, which were
  consolidated into this one polymorphic table.

**DTO:** `backend/crates/shared/src/user.rs::UserMembership` (the
company-membership row joined for `/api/users` + `/api/me`),
`backend/crates/shared/src/company.rs::CompanyMember` (the membership
row joined with the user's profile for the members list).
**Routes:** `backend/crates/api/src/routes/companies.rs` (member
sub-routes — see [company](company.md#supported-calls)).
`backend/crates/api/src/routes/admin.rs` carries the cross-scope
paginated list for the Home Memberships tab (`?scope=project|company`
discriminator).

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create (company)` | `POST /api/companies/:rid/members` | Body: `{ user_id, role }`. Owner-only for granting `role: 'owner'`. Existing membership UPSERTs to the new role. Emits `company_member_add`. |
| `create (project)` | — | **Not exposed via a member route.** Project ownership IS membership-backed today: a `role='owner'` row in `memberships` is written on project create and read by `db::project_owner` (the owner gate). What's not yet exposed is a public `/api/projects/:rid/members` route for the additive admin/member/viewer grants — that lands with project RBAC. |
| `create (admin)` | `POST /api/admin/memberships` | Cross-scope admin path landed via Slice D coordination. Body carries `scope: 'company' | 'project'` discriminator + the corresponding parent rid + user_id + role. |
| `read` | — | **Not supported individually.** Memberships surface via the parent's members list (`GET /api/companies/:rid/members`) or via the user's profile (`UserProfile.memberships[]` on `/api/users`). |
| `update` | `PATCH /api/companies/:rid/members/:user_id` | Body: `{ role }`. Owner-only for promoting to `owner`. Last-owner demotion blocked. Emits `company_member_role_change`. |
| `delete (self)` | `DELETE /api/companies/:rid/members/:user_id` (self-actor) | Self-leave. Last-owner removal blocked. Emits `company_member_leave`. |
| `delete (other)` | `DELETE /api/companies/:rid/members/:user_id` (other-actor) | Admin / owner removes another member. Last-owner removal blocked. Emits `company_member_remove`. |
| `delete (admin cross-scope)` | `DELETE /api/admin/memberships/:rid` | Special path — the membership PK is composite, so this endpoint takes a synthetic encoded rid that decodes back to `(parent_id, user_redpash_id)` on the server side. |
| `list (per-company)` | `GET /api/companies/:rid/members` | Returns `Vec<CompanyMember>` — membership rows joined with the user's profile (display_name / username / avatar_url) so the members list renders without a second lookup. |
| `list (admin)` | `GET /api/admin/memberships?scope=company|project&page&size&sort&dir&q` | Paginated `Page<MembershipSummary>` for the Home Memberships tab. Both scopes query the same `memberships` table, discriminated by joining `projects` vs `companies` on `object_redpash_id`. `scope=` defaults to `project` when absent (the rail-tab's "first paint" landing). |
| `search` | `GET /api/admin/memberships?q=…` | ILIKE substring on `user_display_name` + `user_username` + `scope_name` (project name or company name). |

---

## Fields

These rows have no `redpash_id` — the composite PK is the identity.
One table, one shape across every scope.

```
object_redpash_id
  Type:        TEXT NOT NULL / String — FK to entities.id
  Properties:  Layout
  Description: The parent entity the membership scopes — a company,
               project, or case (the joined entity type
               discriminates the scope). The SAME column for every
               scope: there is no `company_id` / `project_redpash_id`
               column. CASCADE on parent delete (deleting a company
               / project / case removes its memberships; the users
               themselves stay). Part of the composite PK with
               user_redpash_id.
```

```
user_redpash_id
  Type:        TEXT NOT NULL / String — FK to users.redpash_id
  Properties:  Layout
  Description: The member's user. CASCADE on user delete (deleting
               a user removes their memberships). Part of the
               composite PK with the parent FK.
```

```
role
  Type:        TEXT NOT NULL DEFAULT 'member' / String — enum (see "Enum constraints")
  Properties:  Update, Sort, Layout
  Description: The member's role within the parent. One CHECK for
               every scope: `CHECK (role IN ('owner', 'admin',
               'member', 'viewer'))`, default 'member'. There is NO
               'collaborator' value — the old project 'collaborator'
               rows migrated to 'member'. Project ownership is a
               `role='owner'` row written on project create. Per-scope
               narrowing (e.g. companies offer only owner/admin/member)
               is enforced at the route layer, not the column CHECK.
```

```
context_role
  Type:        TEXT / Option<String>
  Properties:  Update, Layout
  Description: Free-text business descriptor for the membership,
               separate from the access `role`. Holds 'Reporter' /
               'Case Owner' on case rows; 'CEO' / 'Department' etc.
               on org/project rows; NULL when there's no business
               label. Collapsed from the former `display_name` +
               `relationship_attribute` columns into this single
               descriptor.
```

```
joined_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Insertion timestamp. Default sort key on the admin
               list endpoint + the per-company members list (most-
               recent first). On role-change, joined_at is NOT
               bumped — the original join date stays; only the
               role column flips.
```

### Hydrated read-only fields

These appear on the admin-list `MembershipSummary` + the per-company
`CompanyMember` shape but aren't columns on the join tables —
they're computed via JOINs at SELECT time.

```
user_display_name, user_username, user_avatar_url
  Type:        TEXT / String  (+ Option<String> for avatar)
  Properties:  Sort (user_display_name + user_username only), Layout
  Description: users.display_name / username / avatar_url JOINed
               on user_redpash_id. Drives the member chip + the
               "Member" column on the Home Memberships tab.
```

```
scope_name
  Type:        TEXT / String
  Properties:  Sort, Layout
  Description: companies.name OR projects.name JOINed on the
               parent FK, depending on the admin endpoint's
               `?scope=` query. The same SELECT alias is reused
               across both scope queries so the SORTABLE allow-list
               resolves uniformly.
```

```
scope  (admin endpoint only)
  Type:        TEXT / String — literal enum value 'project' | 'company'
  Properties:  Sort, Layout
  Description: The scope discriminator emitted as a literal column
               by the admin SELECT (one value per response since
               the WHERE filters by it). Sorting by it within a
               single result set is a no-op; kept in the allow-list
               so the FE chevron still works.
```

---

## Enum constraints

`memberships.role ∈ { owner, admin, member, viewer }`, default
`member` — a single DB-side CHECK on the unified table (no separate
per-scope CHECK). There is NO `collaborator` value: the old project
`collaborator` rows were migrated to `member`. Role hierarchy:
`owner > admin > member > viewer`.

Per-scope narrowing is a route-layer concern, not a column CHECK:
company member routes offer only `owner / admin / member`. Project
ownership is already membership-backed — a `role='owner'` row is
written on project create and read by `db::project_owner`; the
additive admin/member/viewer grants surface when project RBAC routes
land.

Last-owner guard (applies to **company-scope memberships only** today):
- Cannot demote the last `owner`.
- Cannot remove the last `owner` (self-leave or admin-remove).
Enforced via `db::company_owner_count` in the route handlers.

The `scope` discriminator on `/api/admin/memberships` is **not** a
column — it's a query-param value forwarded as a literal in the
SELECT. Allowed values: `project` | `company`. Bad values get a
clean 400.

---

## Relationships

```
object_redpash_id → Company (CMP_)  [company-scope rows]
  Cardinality:  N:1 (a Company has many memberships)
  On delete:    CASCADE (via entities.id; deleting a company removes
                its memberships)
  Hydrated as:  scope_name (admin endpoint) — companies.name
                JOINed at SELECT time
```

```
object_redpash_id → Project (PRJ_)  [project-scope rows]
  Cardinality:  N:1 (a Project has many memberships; the owner row
                is live now, additive grants land with project RBAC)
  On delete:    CASCADE (via entities.id)
  Hydrated as:  scope_name (admin endpoint) — projects.name
                JOINed at SELECT time
```

```
user_redpash_id → User (USR_)
  Cardinality:  N:1 (a User has many memberships across
                companies + projects)
  On delete:    CASCADE
  Hydrated as:  user_display_name + user_username + user_avatar_url
```

### Inverse relationships

```
Membership has no sub-rows.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `company_member_add` | `POST /api/companies/:rid/members` (new row) | `{ company, user, role }` |
| `company_member_role_change` | `PATCH /api/companies/:rid/members/:user_id` (role change) | `{ company, user, role, prev_role }` |
| `company_member_leave` | `DELETE /api/companies/:rid/members/:user_id` (self-actor) | `{ company, user }` |
| `company_member_remove` | `DELETE /api/companies/:rid/members/:user_id` (other-actor) | `{ company, user, removed_by }` |

Project-scope membership mutations emit **no events** today beyond the
implicit owner row written on project create — no user-facing member
route mutates them. When project RBAC adds the members endpoints, the
kinds will mirror the company set:
`project_member_add` / `_role_change` / `_leave` / `_remove`. The
event-key prefix pattern (`<parent>_member_*`) is the canonical
shape — keeps the activity-feed filter chips one-to-one with the
membership scopes.

The cross-scope `/api/admin/memberships` create + delete go
through the same emit paths (a `POST /api/admin/memberships`
adding a company-scope row emits `company_member_add` with the
admin caller's user rid in context).
