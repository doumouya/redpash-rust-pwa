---
title: Me
section: API
order: 2
---

# `/api/me`

The session user's profile. Single endpoint, but the resolution logic
behind it (`resolve_user_rid`) is reused by **every** owner-scoped
handler in the codebase — so this page doubles as the spec for "who is
this request for?"

**Route file:** [`crates/api/src/routes/me.rs`](../../backend/crates/api/src/routes/me.rs)
**DTO:** [`shared::user::UserProfile`](../objects/user.md)

---

## `GET /api/me`

Returns the `UserProfile` for whoever owns the request.

### Resolution order

1. **`rp_session` cookie present** → look up `sessions.session_id` → if
   the row is unexpired, return its user.
2. **No session cookie + OAuth unconfigured** → fall back to the
   bootstrap `dev_user`. This is local-dev mode — there is exactly one
   user record per machine.
3. **No session cookie + OAuth configured** → `401 unauthenticated`.
   The frontend's `api.js` catches this and redirects the browser to
   `#/landing`.

### Response

```jsonc
200 OK
{
  "redpash_id":   "USR_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2",
  "username":     "em.doumouya.5f3c7a21",
  "email":        "em.doumouya@gmail.com",
  "display_name": "Emmanuel Doumouya",
  "avatar_url":   "https://lh3.googleusercontent.com/a/…",
  "job_title":    null,
  "organisation": null,
  "use_case":     null,
  "plan":         "free",
  "locale":       "en",
  "prefs":        {}
}
```

`google_sub` is **not** returned — it's a private auth detail kept in
the row but stripped from the DTO.

See [objects/user.md](../objects/user.md) for the full field reference.

### Errors

| Status | `kind`              | When |
|--------|---------------------|------|
| 401    | `unauthenticated`   | OAuth enabled and no valid `rp_session` cookie |
| 404    | `not_found`         | Session cookie pointed at a deleted user row (rare; race with manual DB cleanup) |
| 500    | `db` / `internal`   | Postgres unreachable / unexpected error |

---

## `resolve_user_rid` (the shared helper)

The resolver is exported as `pub` from `routes::me` and re-exported as
`pub(crate)` from `routes::mod`. Every owner-scoped handler calls it
first:

```rust
async fn list(State(state): State<AppState>, headers: HeaderMap)
    -> Result<Json<…>, AppError>
{
    let user = super::resolve_user_rid(&state, &headers).await?;
    // …owner-scoped query…
}
```

**Every** owner-scoped handler now calls it — list endpoints (`/api/projects`, `/api/reports`, `/api/dashboards`), upload (`POST /api/files/upload`), `PATCH /api/me`, **and** every detail handler on `/api/{projects,reports,dashboards,files}/:rid/*`. Detail handlers pair it with the ownership gate below.

## `ensure_owner` (the shared 404 gate)

```rust
super::ensure_owner(
    db::report_owner(&state.db, &rid).await,  // Result<Option<owner_rid>>
    &user, "report", &rid,
)?;
```

Re-exported from `routes::mod` as `pub(crate)`. Pairs with one of the
four lookup helpers — `project_owner`, `report_owner`,
`dashboard_owner`, `file_owner` — each a single JOIN to
`projects.owner_id`. 404 with `kind="not_found"` on **both** "resource
doesn't exist" and "exists but not yours" — same message format so the
existence of someone else's resource is never leaked.

---

## `PATCH /api/me`

Sparse update of the session user's profile. Every field is optional;
`prefs` is shallow-merged with the existing JSONB via the `||` operator
so callers can flip a single key without re-sending the whole object.

### Request body

```jsonc
{
  "display_name": "Emmanuel",            // optional — overwrites column
  "job_title":    "Ops analyst",
  "organisation": "Acme",
  "use_case":     "weekly dossier exports",
  "locale":       "fr",
  "prefs":        { "accent": "#b3001b" } // optional — shallow-merged
}
```

Server side: `UPDATE users SET <col> = COALESCE($n, <col>), …, prefs =
prefs || COALESCE($prefs, '{}'::jsonb), updated_at = now() WHERE
redpash_id = $1 RETURNING …`.

### Response

The refreshed `UserProfile` — same shape as `GET /api/me`.

### Errors

| Status | `kind`              | When |
|--------|---------------------|------|
| 401    | `unauthenticated`   | OAuth enabled, no session |
| 404    | `not_found`         | Session user row vanished mid-request (defensive) |
| 500    | `db`                | UPDATE failed |

The frontend's [`/profile`](../../frontend/scripts/pages/profile.js)
page sends every editable field on submit (no dirty-tracking); the
[`/settings`](../../frontend/scripts/pages/settings.js) page sends only
`{prefs: {…}}`.

---

## Related

- [auth.md](auth.md) — how the `rp_session` cookie gets minted.
- [objects/user.md](../objects/user.md) — DTO + table schema.
- [auth/google.md](../auth/google.md) — full OAuth setup walkthrough.
