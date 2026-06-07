---
title: Companies
section: API
order: 5
last modified date: 2026-05-30
---

# `/api/companies/*`

A company is the multi-tenancy boundary: a user belongs to zero or more
companies via the **unified `memberships` table** (object = the company),
and a project is either company-scoped (`projects.company_id`) or personal.
Membership doubles as the access-control check — every handler resolves the
caller's role and **404s** (not 403) when they aren't a member, so company
existence is never leaked.

> **Dev relaxation.** While the app is still in active development,
> the membership gate on `PATCH` and `DELETE` is **off** ("we are
> still developping the App, I can't have restriction") — every signed-
> in user can edit / delete any company from the Objects page. The
> guards documented below for those two endpoints are the *target*
> shape, to re-enable before any non-dev deployment.

**Route file:** [`crates/api/src/routes/companies.rs`](../../backend/crates/api/src/routes/companies.rs)
**DTOs:** [`shared::company`](../../backend/crates/shared/src/company.rs) — `Company`, `CompanySummary`, `CompanyMember`
**Migrations:** 007 (companies + the legacy `company_memberships`) → **023 consolidated** company + project memberships into the polymorphic `memberships` table (PK `(object_redpash_id, user_redpash_id)`, FK → `entities.id ON DELETE CASCADE`).

---

## Roles

`owner` > `admin` > `member`.

| Action | Required role |
|---|---|
| List / read company + members | any member |
| Create a company | any signed-in user (becomes `owner`) |
| Patch company metadata, add / change / remove members | `owner` or `admin` |
| Grant the `owner` role | `owner` only |
| Remove or demote an `owner` | `owner` only, and never the **last** owner |
| Leave a company (remove self) | any member (still can't strand the last owner) |
| Delete a company | `owner` only |

`admin` can't remove an `owner`; the last `owner` can't be removed or
demoted (transfer ownership first).

---

## `GET /api/companies`

All companies, sorted by `name`. Each carries the caller's role (when
they're a member) and the total member count. The query LEFT JOINs
`memberships ON object_redpash_id = companies.redpash_id AND user_redpash_id
= :me`, so non-members see the row with `my_role: null` rather than
having it filtered out — same dev-relaxation rationale as above (the
Objects-page Companies tab needs to show every company so it can be
edited / deleted from there).

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":   "CMP_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2",
      "name":         "Acme Data Co",
      "slug":         "acme-data-co-5f3c7a",   // immutable, auto-derived
      "avatar_url":   null,
      "created_at":   "2026-05-21T09:00:00Z",
      "updated_at":   "2026-05-21T09:00:00Z",
      "member_count": 4,
      "my_role":      "owner"      // null when caller isn't a member
    }
  ]
}
```

`my_role` is `Option<String>` in the DTO (was `String` before the LEFT
JOIN refactor); the frontend's `_objBadge` / `canDeleteRow` checks
treat `null` the same as "no role yet".

---

## `POST /api/companies`

Create a company. The creator is seated as its `owner` in the same
transaction, so a company never exists without an owner.

```jsonc
POST /api/companies
{
  "name": "Acme Data Co",
  "slug": "acme"            // optional — base for the slug; defaults to slugified name
}
```

`slug` is **auto-derived** at create: `{slugified-base}-{6-hex}` (a
slice of the new RID) so it's unique by construction — no collision
retry. It's not fixed forever, though — `PATCH /api/companies/:rid`
can rename it (see below); a collision there returns `409
slug_taken`. Returns the created `Company`.

---

## `GET /api/companies/:rid`

The company record. Requires membership.

---

## `PATCH /api/companies/:rid`

Sparse update — `name`, `slug`, and `avatar_url`. `slug` graduated
from immutable to user-editable so the Objects-page inline edit can
rename a company's URL handle; the underlying column is `UNIQUE`, so
a collision returns **`409 conflict / slug_taken`** instead of the
old 500. Membership / role gates are currently off (dev relaxation).

```jsonc
PATCH /api/companies/CMP_…
{ "name": "Acme Analytics", "slug": "acme-analytics", "avatar_url": "https://…/logo.png" }
```

Empty `name` is dropped server-side. Returns the updated `Company`.

---

## `DELETE /api/companies/:rid`

Delete a company. Owner-only is the target gate; currently
dev-permissive — any signed-in user can delete via the Objects-page
trash. The delete routes through `delete_entity` (`DELETE FROM entities
WHERE id = $1`); the company row + its `memberships` cascade out of the
registry, and `projects.company_id` is `ON DELETE SET NULL` so company
projects survive as personal projects rather than being deleted.

```jsonc
200 OK
{ "ok": true }
```

---

## Members

Company members are managed through the **generic object-member CRUD** —
`GET·POST /api/companies/:rid/members` and
`PATCH·DELETE /api/companies/:rid/members/:member_id` — the same implementation
mounted under projects / cases / teams. The roster row, request bodies, role
rules (`owner` grants `owner`; last-owner guard; self-leave), and error shapes
are documented once in **[members.md](members.md)**. The role model above
(`owner` > `admin` > `member`) is what those endpoints enforce on a company.

---

## Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | Empty company name; `role` not one of owner/admin/member |
| 401    | `unauthenticated` | OAuth enabled, no session cookie |
| 403    | `forbidden`       | Authenticated + a member, but role too low for the action (or last-owner / admin-vs-owner guard) — currently bypassed on `PATCH` / `DELETE` |
| 404    | `not_found`       | Company RID missing **or** caller isn't a member; membership / target user not found |
| 409    | `conflict / slug_taken` | `PATCH` requested a `slug` that already belongs to another company (UNIQUE constraint 23505 → mapped) |
| 500    | `db`              | Postgres unreachable |

---

## Related

- [projects.md](projects.md) — `PATCH /api/projects/:rid` accepts a
  `company_id` to scope a project to a company the editor belongs to.
- [db/schema.md](../db/schema.md) — `companies`, `entities`, the unified
  `memberships` table definitions.

---

## Scope note

Migration 007 landed the company **data model** and this `/api/companies`
resource. Migrations 022 / 023 / 024 then consolidated the access substrate
(entity registry + unified memberships + ownership-as-membership) so
membership lookups are uniform across companies and projects. Company-scoped
*visibility* of projects / files / charts / dashboards / cases is still a
deliberate follow-up; the schema is uniform, the read-side gates just
haven't been extended past the per-resource owner check yet.
