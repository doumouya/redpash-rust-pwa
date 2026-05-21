---
title: User
section: Objects
order: 0
last modified date: 2026-05-21
---

# User (`UserProfile`)

**DTO:** `shared::user::UserProfile`
**Table:** `users`
**RID prefix:** `USR`
**Migration:** 001 init + 006 auth (adds `google_sub`)

---

## What a User is

The identity anchor for every other row in the schema. Owns projects;
projects own files, steps, reports, dashboards. The `users.redpash_id`
is the FK target for `projects.owner_id`.

Today there are two ways a user comes into existence:

1. **Bootstrap dev_user** — `crates/api/src/bootstrap.rs` runs at
   startup and creates a single user with `username = "dev"` if one
   doesn't already exist. Used as the request identity when Google
   OAuth is unconfigured (local development).
2. **Google OAuth upsert** — first time someone signs in with Google,
   `db::upsert_google_user` inserts a row with the user's Google `sub`
   claim, email, display name, avatar URL. Returning users match on
   `google_sub` and have their `email` / `display_name` / `avatar_url`
   refreshed each sign-in.

There is **one** user record per Google account. Cross-provider
account linking is not implemented; an account that previously signed
in via a different mechanism would create a new RID.

---

## Fields

The `users` table columns. Most map straight to the `UserProfile` DTO;
three are **not** in it — `created_at` / `updated_at` (timestamps aren't
surfaced) and `google_sub` (a private auth detail, matched on sign-in).
The DTO also carries a joined `memberships` array with no `users` column
behind it — see [Company memberships](#company-memberships).

| Field | DB column | Type | Nullable | Default | Description |
|---|---|---|---|---|---|
| `redpash_id` | `redpash_id` | `TEXT` PK | NO | — | `USR_…` |
| `username` | `username` | `TEXT` UNIQUE | NO | — | Login handle. For bootstrap = `"dev"`; for OAuth users = `{email-local-part}.{rid-suffix}` to guarantee uniqueness |
| `email` | `email` | `TEXT` | YES | — | From Google's `email` claim. Refreshed each sign-in |
| `display_name` | `display_name` | `TEXT` | NO | `"Dev user"` (bootstrap) | From Google's `name` claim, or email local part if missing |
| `avatar_url` | `avatar_url` | `TEXT` | YES | — | Google's `picture` claim — full `https://lh3.googleusercontent.com/…` URL |
| `job_title` | `job_title` | `TEXT` | YES | — | Onboarding field. Edited on the Profile page via `PATCH /api/me`. |
| `organisation` | `organisation` | `TEXT` | YES | — | Onboarding field |
| `use_case` | `use_case` | `TEXT` | YES | — | Free-form; may be enum-constrained later |
| `plan` | `plan` | `TEXT` | NO | `"free"` | Subscription plan (see below) |
| `locale` | `locale` | `TEXT` | NO | `"en"` | UI language preference |
| `prefs` | `prefs` | `JSONB` | NO | `'{}'::jsonb` | Per-user UI overrides — accent color override, table density, etc. |
| `created_at` | `created_at` | `TIMESTAMPTZ` | NO | `now()` | |
| `updated_at` | `updated_at` | `TIMESTAMPTZ` | NO | `now()` | Touched on every column update |
| *(not in DTO)* `google_sub` | `google_sub` | `TEXT` | YES | — | OpenID subject claim. Unique partial index `WHERE google_sub IS NOT NULL` so bootstrap users with NULL don't collide |

### `plan` values (planned)

| Value | Meaning |
|---|---|
| `free` | Default — feature-limited (3 projects, CSV export only) |
| `trial` | 30-day full-feature trial |
| `pro` | Paid subscription |

Set server-side. No user-facing upgrade flow yet — billing lands with
Phase 6.

### Company memberships (`memberships`)

`UserProfile` carries one DTO-only field with no `users` column behind it:

```rust
#[serde(default)]
pub memberships: Vec<UserMembership>,

pub struct UserMembership {
    pub company_id:   String,
    pub company_name: String,
    pub role:         String,   // owner | admin | member
}
```

`memberships` lists the user's company memberships, joined in by
`GET /api/users` (the Objects → Users tab) so each row shows which
companies a user belongs to. It is `#[serde(default)]` and left **empty**
by single-row fetchers that skip the join — `find_user_by_id`,
`find_user_by_username`, and `GET /api/me` all return `[]`. A user in no
company also has `[]`.

---

## DB helpers (`crates/api/src/db.rs`)

| Helper | SQL | Used by |
|---|---|---|
| `find_user_by_id(rid)` | `SELECT … FROM users WHERE redpash_id = $1` | `routes::me`, `bootstrap` |
| `find_user_by_username(name)` | `SELECT … WHERE username = $1` | `bootstrap::run` (checks for the dev user) |
| `find_user_by_google_sub(sub)` | `SELECT … WHERE google_sub = $1` | `db::upsert_google_user` |
| `insert_user(rid, username, display_name)` | minimal INSERT — used by `bootstrap.rs` for the dev user | `bootstrap::run` |
| `upsert_google_user(sub, email, display_name, avatar_url?)` | matches on `google_sub`; INSERT on miss, UPDATE on hit | `routes::auth::callback` |

`upsert_google_user`'s INSERT path also generates the new RID via
`crate::id::new("USR")`.

---

## Resolution (who is the request for?)

There is **one** resolver everyone consults — `resolve_user_rid` in
`routes::me`, re-exported as `pub(crate)` from `routes::mod`:

```rust
pub async fn resolve_user_rid(state: &AppState, headers: &HeaderMap)
    -> Result<String, AppError>
{
    // 1. Try the rp_session cookie → DB lookup → user RID.
    // 2. Else, if OAuth is unconfigured → fall back to dev_user.
    // 3. Else → 401 (frontend redirects to landing).
}
```

Every owner-scoped handler calls this **first**:

```rust
async fn list(State(state): State<AppState>, headers: HeaderMap)
    -> Result<Json<…>, AppError>
{
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_reports(&state.db, &user).await?;
    Ok(Json(…))
}
```

---

## API

### `GET /api/me`

**Auth:** session cookie or dev_user fallback
**Response:** `UserProfile`

```json
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

When no session cookie is present and OAuth is **configured**, the
endpoint returns 401 — the frontend's `api.js` intercepts it and
redirects to `#/landing`. With OAuth **unconfigured**, the bootstrap
dev_user is returned so local development keeps working without a
sign-in.

### `PATCH /api/me`

Sparse update of the session user. Every body field is optional;
`prefs` is shallow-merged with the existing JSONB. See
[api/me.md](../api/me.md) for the request/response shape and error
table.

Implemented as `db::update_user` — one SQL statement using
`COALESCE($n, column)` per field and `prefs = prefs ||
COALESCE($prefs, '{}'::jsonb)` for the merge.

---

## Auth flow (Google OAuth)

```
Browser                   redpash-api                   Google
   │  click "Sign in"
   ├─────────────────────►│  GET /api/auth/google/start
   │                      │  → set rp_oauth_state
   │ ◄────────────────────┤  → 302 redirect
   ├──────────────────────────────────────────────────►
   │                                                   │  consent
   │ ◄─────────────────────────────────────────────────┤
   ├─────────────────────►│  GET /…/callback?code&state
   │                      │  verify state
   │                      ├──────────────────────────►│  POST /token
   │                      ├──────────────────────────►│  GET /userinfo
   │                      │  upsert_google_user
   │                      │  ensure_default_project (idempotent)
   │                      │  create_session → SES_…
   │ ◄────────────────────┤  → set rp_session cookie + 302 /
```

Full setup: [auth/google.md](../auth/google.md).

---

## Frontend

| Asset | Location |
|---|---|
| **Landing button** | `partials/landing.html` — `<a href="/api/auth/google/start">` |
| **User-menu dropdown** | `scripts/main.js::renderTopbar` — chip toggles Profile / Settings / Sign out |
| **Profile page** | `partials/profile.html` + `scripts/pages/profile.js` — GET `/me`, PATCH `/me` on save |
| **Settings page** | `partials/settings.html` + `scripts/pages/settings.js` — accent + density `prefs` editor |
| **Boot apply** | `scripts/main.js::loadSession` reads `session.prefs.accent` and sets `--rp-accent` so the override survives reloads |
| **401 redirect** | `scripts/api.js` — every API response checks `status === 401` and routes to `#/landing` |

---

## Notes

- The `username` UNIQUE constraint is the only thing protecting
  against duplicate inserts. The OAuth path appends the first 8 chars
  of the new RID to the email local part so two users with the same
  email prefix don't collide (`em.doumouya.5f3c7a21` vs
  `em.doumouya.9a2d6c71`).
- `google_sub` is the **only** key matched for returning users.
  Matching on email would mean a user who changes their Google email
  loses their account.
- `state.dev_user` is read by exactly one place — `routes::me::resolve_user_rid`
  — when OAuth is unconfigured. Every other handler resolves through
  the session cookie.
