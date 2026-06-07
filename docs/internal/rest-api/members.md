---
title: Members (object membership)
section: API
order: 7
last modified date: 2026-06-03
---

# `/api/{object}/:rid/members/*`

**One generic implementation** of member management over the polymorphic
`memberships` edge, mounted under every object entity that has members —
companies, projects, cases, and teams. There is no `/api/members` resource;
`routes/members.rs` is `nest`ed under each parent's `/:rid/members` path, and
the DB helpers key on `object_redpash_id` (the `company_*` helper names are
cosmetic). The membership row *is* both the access-control check and the org
graph.

**Route file:** [`crates/api/src/routes/members.rs`](../../backend/crates/api/src/routes/members.rs)
**DTO:** [`shared::company::CompanyMember`](../../backend/crates/shared/src/company.rs) (the roster row — reused for every object type)
**Mounted by:** [companies.md](companies.md) · [projects.md](projects.md) · [cases.md](cases.md) · [teams.md](teams.md)

---

## Roles & gates

`owner > admin > member`. A **manager** is an owner/admin **directly on the
object** *or* via the object's company/project cascade, *or* a platform admin
(reach-aware — this is what lets a company admin manage a case team). Roster
bookkeeping (last-owner / demotion guards) stays direct on the object.

| Action | Required |
|---|---|
| List members | any effective role on the object (member+ via direct / cascade / team), or platform admin |
| Add / change-role / remove a member | manager (owner/admin direct-or-cascade) or platform admin |
| Grant the `owner` role | `owner` only |
| Remove / demote an `owner` | `owner` only, never the **last** owner |
| Remove **self** (leave) | any member |

404 (leak-free) when the caller has no reach; 403 when they're a member but
lack the manage tier.

---

## Endpoints

The same four operations exist under each parent (`:rid` = the parent object's
RID; `:member_id` = the member's user RID):

| Method · Path | Body / Returns |
|---|---|
| `GET /api/companies/:rid/members`            | → `{ items: [CompanyMember] }` |
| `POST /api/companies/:rid/members`           | `AddMemberBody` → refreshed list |
| `PATCH /api/companies/:rid/members/:member_id`  | `PatchMemberBody` → refreshed list |
| `DELETE /api/companies/:rid/members/:member_id` | → refreshed list |
| `GET /api/projects/:rid/members`             | → `{ items: [CompanyMember] }` |
| `POST /api/projects/:rid/members`            | `AddMemberBody` → refreshed list |
| `PATCH /api/projects/:rid/members/:member_id`   | `PatchMemberBody` → refreshed list |
| `DELETE /api/projects/:rid/members/:member_id`  | → refreshed list |
| `GET /api/cases/:rid/members`                | → `{ items: [CompanyMember] }` |
| `POST /api/cases/:rid/members`               | `AddMemberBody` → refreshed list |
| `PATCH /api/cases/:rid/members/:member_id`      | `PatchMemberBody` → refreshed list |
| `DELETE /api/cases/:rid/members/:member_id`     | → refreshed list |
| `GET /api/teams/:rid/members`                | → `{ items: [CompanyMember] }` |
| `POST /api/teams/:rid/members`               | `AddMemberBody` → refreshed list |
| `PATCH /api/teams/:rid/members/:member_id`      | `PatchMemberBody` → refreshed list |
| `DELETE /api/teams/:rid/members/:member_id`     | → refreshed list |

Mutations return the **refreshed member list** (not just the changed row) so the
caller can repaint the roster in one round-trip.

### `AddMemberBody`
```jsonc
{
  "user_id": "USR_…",
  "role":    "admin"        // optional — owner | admin | member (default "member")
}
```

### `PatchMemberBody`
```jsonc
{ "role": "admin" }         // owner | admin | member
```

### Roster row (`CompanyMember`)
```jsonc
{
  "member_redpash_id": "USR_9A2B…",   // the member's user RID
  "display_name":      "Jane Smith",
  "username":          "jane.9a2b3c4d",
  "avatar_url":        null,
  "role":              "owner",
  "joined_at":         "2026-05-21T09:00:00Z"
}
```

---

## Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | `role` not owner/admin/member |
| 403    | `forbidden`       | A member without the manage tier; last-owner / admin-vs-owner guard |
| 404    | `not_found`       | Object RID missing **or** caller has no reach; target member not found |
| 500    | `db`              | Postgres unreachable |

---

## Related

- [companies.md](companies.md) · [projects.md](projects.md) · [cases.md](cases.md) · [teams.md](teams.md)
- [db/schema.md](../db/schema.md) — the unified `memberships` table (PK `(object_redpash_id, user_redpash_id)`).
