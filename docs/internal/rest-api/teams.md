---
title: Teams
section: API
order: 6
last modified date: 2026-06-03
---

# `/api/teams/*`

A **team** is a company-scoped subgroup. It doubles as a grant-bearing
principal in the RBAC resolver (`rbac::caller_principals`), so a team's members
inherit the grants the team holds. The membership edge is the same polymorphic
`memberships` table as companies / projects / cases, so member management is the
generic object-member CRUD — see [members.md](members.md).

**Route file:** [`crates/api/src/routes/teams.rs`](../../backend/crates/api/src/routes/teams.rs)
**DTOs:** [`shared::team`](../../backend/crates/shared/src/team.rs) — `Team`, `TeamSummary`
**Members:** `GET·POST /:rid/members`, `PATCH·DELETE /:rid/members/:member_id` — documented in [members.md](members.md).

---

## Roles

`owner > admin > member`. Only an `owner` mints another `owner`; the last
`owner` can't be removed or demoted (transfer first). Gates live in
`routes/members.rs`.

| Action | Required reach |
|---|---|
| List / read a team + members | a member, or a member of its parent company (cascade), or platform admin |
| Create a team | at least **member** of the parent company |
| Patch a team | team **admin**+ (direct) or platform admin |
| Delete a team | team **owner** (direct) or platform admin |

---

## `GET /api/teams`

Teams the caller can see: platform admins see every team; everyone else sees
teams they belong to plus teams of a company they belong to. Each row carries
the caller's role (`my_role`, `null` when not a direct member) and a member count.

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":   "TEM_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2",
      "company_id":   "CMP_9A2B…",
      "name":         "Data Platform",
      "kind":         "team",
      "created_at":   "2026-05-21T09:00:00Z",
      "company_name": "Acme Data Co",
      "member_count": 4,
      "my_role":      "owner"
    }
  ]
}
```

---

## `POST /api/teams`

Create a team in a company the caller belongs to (member+; platform admins
bypass). `kind` is `team` (default) or `department` — departments carry the
single-parent / one-direct-department-per-user invariants. Returns the `Team`.

```jsonc
POST /api/teams
{
  "name":       "Data Platform",
  "company_id": "CMP_9A2B…",
  "kind":       "team"          // optional — "team" (default) | "department"
}
```

A bad `company_id` returns `404 not_found`; an empty `name` or an invalid
`kind` returns `400 invalid`.

---

## `GET /api/teams/:rid`

The team record. Requires reach (member of the team or its company, or platform
admin). 404 (leak-free) otherwise.

```jsonc
200 OK
{
  "redpash_id": "TEM_5F3C…",
  "company_id": "CMP_9A2B…",
  "name":       "Data Platform",
  "kind":       "team",
  "created_at": "2026-05-21T09:00:00Z"
}
```

---

## `PATCH /api/teams/:rid`

Rename a team. Requires team **admin**+ (direct) or platform admin. Sparse —
only `name` is editable today. Empty `name` is dropped server-side. Returns the
updated `Team`.

```jsonc
PATCH /api/teams/TEM_…
{ "name": "Platform Engineering" }
```

---

## `DELETE /api/teams/:rid`

Delete a team. Requires team **owner** (direct) or platform admin.

```jsonc
200 OK
{ "ok": true }
```

---

## Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | Empty `name`; `company_id` missing; `kind` not team/department |
| 401    | `unauthenticated` | OAuth enabled, no session cookie |
| 403    | `forbidden`       | Authenticated with reach, but role too low for the action |
| 404    | `not_found`       | Team RID missing, parent company missing, **or** caller lacks reach |
| 500    | `db`              | Postgres unreachable |

---

## Related

- [members.md](members.md) — the generic member CRUD mounted at `/:rid/members`.
- [companies.md](companies.md) — the parent scope; same role model.
- [db/schema.md](../db/schema.md) — `teams`, `entities`, the unified `memberships` table.
