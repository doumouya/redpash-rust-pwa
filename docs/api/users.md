---
title: Users
section: API
order: 9
last modified date: 2026-05-16
---

# `/api/users/*`

Single-tenant user directory. Powers the Objects page's owner-
reassignment picker (`edit.type: "select"` with `source: "users"`) and
the **Users** browse tab — and, in dev, full CRUD against any user.

**Route file:** [`crates/api/src/routes/users.rs`](../../backend/crates/api/src/routes/users.rs)
**DTOs:** [`shared::user`](../../backend/crates/shared/src/user.rs) — `UserProfile`, `UserMembership`

> **Dev relaxation.** All four endpoints are dev-permissive — any
> authenticated user can read / create / patch / delete any user. The
> only existence check is `resolve_user_rid` (must have a session).
> Tighten before any multi-tenant deployment.

---

## `GET /api/users`

Every user, sorted by `display_name`. Each row carries the user's
`company_memberships` (a separate query attached per-user) so the
Objects-page Users tab can display a member's companies + roles
without a second roundtrip.

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":   "USR_9A2B…",
      "display_name": "Jane Smith",
      "username":     "jane.9a2b3c4d",
      "email":        "jane@example.com",
      "plan":         "pro",
      "avatar_url":   null,
      "memberships":  [
        { "company_id": "CMP_…", "company_name": "Acme", "role": "owner" }
      ]
      /* …more UserProfile fields… */
    }
  ]
}
```

---

## `POST /api/users` — create

Dev-only quick create — the Objects-page Users tab's **Add** button
runs this via `addAction` (a `window.prompt`-based stop-gap; a proper
modal is on the backlog).

```jsonc
POST /api/users
{
  "username":     "jane.s",
  "display_name": "Jane Smith",
  "email":        "jane@example.com"   // optional
}
```

`username` is `UNIQUE`; a collision returns **`409 conflict /
username_taken`** (UNIQUE 23505 → mapped).

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | Empty `username` / `display_name` |
| 401    | `unauthenticated` | OAuth enabled, no session |
| 409    | `conflict / username_taken` | `username` already in use |
| 500    | `db`              | Postgres unreachable |

---

## `GET /api/users/:rid`

Fetch one. No ownership gate beyond session presence.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | User RID missing |

---

## `PATCH /api/users/:rid`

Sparse update. All fields optional — only the present, non-empty
trimmed ones change (`COALESCE` in the SQL). Drives the Objects-page
Users-tab inline edit cells.

```jsonc
PATCH /api/users/USR_…
{
  "display_name": "Jane S.",
  "username":     "jane.smith",
  "email":        "jane@acme.com",
  "plan":         "team",
  "avatar_url":   "https://…/avatar.png",
  "job_title":    "Analyst",
  "organisation": "Acme",
  "use_case":     "reporting",
  "locale":       "fr-FR"
}
```

`username` collision returns **`409 conflict / username_taken`**.
Returns the updated `UserProfile`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | User RID missing |
| 409    | `conflict / username_taken` | `username` change collides |

---

## `DELETE /api/users/:rid`

Cascades sessions, `company_memberships`, and the user's owned
projects (via `users.redpash_id` FKs).

```jsonc
200 OK
{ "ok": true }
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | User RID missing |

---

## Related

- [me.md](me.md) — the session user's own profile + `resolve_user_rid`.
- [companies.md](companies.md) — `company_memberships` and the role
  model (the `memberships` array on each user comes from there).
- [Objects page](../frontend/redpash-components-pages/objects-page/index.md)
  — the Users tab + addAction + inline edit wiring.
