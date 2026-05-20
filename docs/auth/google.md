---
title: Google OAuth
section: Auth
order: 1
last modified date: 2026-05-16
---

# Google OAuth (Phase 4a)

Full authorization-code flow. The backend mints sessions; the frontend
just sees an `rp_session` HttpOnly cookie. No refresh tokens — we
re-authenticate via Google when a session expires.

## Setup

1. **Google Cloud Console** → APIs & Services → Credentials → **Create
   OAuth client ID**.
2. **Application type**: Web application.
3. **Authorized redirect URIs**: `http://localhost:8080/api/auth/google/callback`
   (add your production callback later).
4. Copy the **client ID** + **client secret** into `backend/.env`:

   ```env
   GOOGLE_OAUTH_CLIENT_ID=…
   GOOGLE_OAUTH_CLIENT_SECRET=…
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/auth/google/callback
   ```

5. Restart `cargo run -p api`. Logs should show:

   ```
   INFO  google oauth configured (redirect_uri = http://localhost:8080/api/auth/google/callback)
   ```

   If you see `google oauth not configured — running in dev_user mode`,
   one of the three env vars is missing or empty.

## Flow

```
  Browser              redpash-api                     Google
    │                       │                            │
    │  click "Sign in"      │                            │
    ├──────────────────────►│  GET /api/auth/google/start│
    │                       │  → set rp_oauth_state      │
    │                       │  → 302 redirect            │
    │ ◄─────────────────────┤                            │
    │  302 to accounts.google.com/o/oauth2/v2/auth?…     │
    ├────────────────────────────────────────────────────►
    │  consent screen                                    │
    │                                                    │
    │ ◄──────────────────────────────────────────────────┤
    │  302 to /api/auth/google/callback?code=…&state=…   │
    ├──────────────────────►│                            │
    │  GET /…/callback      │  verify state cookie       │
    │                       │  POST oauth2/v2/token      │
    │                       ├───────────────────────────►│
    │                       │ ◄──────────────────────────┤
    │                       │  { access_token, … }       │
    │                       │  GET /v1/userinfo          │
    │                       ├───────────────────────────►│
    │                       │ ◄──────────────────────────┤
    │                       │  { sub, email, name, picture } │
    │                       │  upsert_google_user        │
    │                       │  create_session            │
    │                       │  → set rp_session          │
    │ ◄─────────────────────┤  → 302 /                   │
```

## Routes

| Method | Path                              | Notes |
|--------|-----------------------------------|-------|
| GET    | `/api/auth/google/start`          | Sets `rp_oauth_state` (10 min), redirects to Google's consent screen. 503 when OAuth env vars are unset. |
| GET    | `/api/auth/google/callback`       | Verifies state cookie, exchanges `code` for tokens, calls `/v1/userinfo`, upserts the user, mints a session, sets `rp_session`, redirects to `/`. |
| POST   | `/api/auth/logout`                | Deletes the session row and clears the cookie. |

## Cookies

| Name              | TTL      | Notes |
|-------------------|----------|-------|
| `rp_oauth_state`  | 10 min   | CSRF token bridging `/start` → `/callback`. HttpOnly, SameSite=Lax. |
| `rp_session`      | 30 days  | Session ID (`SES_…`). HttpOnly, SameSite=Lax. `Secure` is **off** in dev — flip on for HTTPS production deploys. |

## Session storage

`sessions` table — `(redpash_id, user_redpash_id, expires_at, created_at)`.
`find_session_user` auto-deletes expired rows on lookup, so the table
naturally garbage-collects on the read path.

## Dev mode (no OAuth)

Leave the three `GOOGLE_OAUTH_*` env vars blank and `state.oauth =
None`. `/api/me` falls back to `state.dev_user` (the bootstrap user
created on first run); auth routes 503. This is the default for local
development and CI.

## Phase 4b — per-user data scoping (shipped)

- `resolve_user_rid(state, headers)` (declared in `routes::me`,
  re-exported from `routes::mod`) is the single source of truth for
  "who is this request for?". It reads the `rp_session` cookie when
  present, looks up `find_session_user`, and falls back to `dev_user`
  *only* when OAuth is disabled (dev mode).
- Every list endpoint (`/api/projects`, `/api/reports`,
  `/api/dashboards`) now scopes by the session user.
- `POST /api/files/upload` calls `db::ensure_default_project(user)` —
  per-user workspace, not the bootstrap dev project.
- `db::ensure_default_project` is idempotent: returns the user's
  default project RID or creates one if missing. Called once per
  upload, and also once from the OAuth callback so brand-new accounts
  land with a usable workspace before their first navigation.
- `state.default_project` was removed; `state.dev_user` is now read
  *only* by `resolve_user_rid` (for the dev-mode fallback).

## What's shipped on top in Phase 4c

- **Per-resource ownership checks** — every detail handler pairs
  `resolve_user_rid` with `super::ensure_owner(db::*_owner(rid), &user,
  …)` and 404s on miss *or* owner mismatch. Same `kind`/message both
  ways so existence isn't leaked. Cross-resource handlers (report
  create / preview, dashboard create, file→file join) gate on every
  referenced RID, not just the path.
- **Logout button** — wired into the user-menu dropdown in
  `frontend/scripts/main.js::renderTopbar`.
- **Profile + Settings** — see `partials/{profile,settings}.html` and
  the matching mount modules. `PATCH /api/me` backs both — sparse update
  for profile fields, shallow JSONB merge for `prefs`.

## What's still NOT here

- **Share-link UI** for the `is_public` toggles (the columns exist on
  `reports` and `dashboards`; no UI surfaces them yet).
- **Refresh tokens** — we don't request `access_type=offline`. When a
  session expires the user re-signs-in.
- **Account linking** — one Google account = one RedPash user. Email
  conflicts on first sign-in aren't yet handled (the unique-index on
  `users.email` would reject; the upsert matches on `google_sub`).
- **`Secure` cookie attribute** — off in dev; flip on for HTTPS.

## Wire format quirks

- `email` claim is always present (we request the `email` scope).
- `name` and `picture` are optional — fall back to the email's local
  part for `display_name` when `name` is missing.
- Google's `sub` is stable across name + email changes, so it's the
  matching key on the upsert. Don't match on email — users can change
  it on Google's side.
