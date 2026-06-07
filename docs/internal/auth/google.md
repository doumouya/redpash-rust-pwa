---
title: Auth — Google OAuth
section: Internal
last modified date: 2026-06-07
---

# Auth — Google OAuth

The production sign-in path. A full OAuth 2.0 **authorization-code** flow
where the backend does all the work: it talks to Google, mints a session
row, and hands the browser a single HttpOnly `rp_session` cookie. The
frontend never sees a Google token — it only ever knows whether it has a
session. There are no refresh tokens; when a session expires the user
re-authenticates against Google.

All three handlers live in `backend/crates/api/src/routes/auth.rs`.

## Why backend-minted sessions

Keeping the OAuth exchange server-side means Google access tokens never
touch JavaScript or `localStorage`. The browser's only credential is an
opaque session ID (`SES_…`) in an HttpOnly cookie it cannot read. This is
the [JS↔Rust boundary](../architecture/js-rust-boundary.md) applied to
auth: the backend owns identity, the frontend owns pixels.

## The flow (two requests + Google)

### 1. `GET /api/auth/google/start`

Mints a random CSRF `state` token (two concatenated UUIDs — ~128 bits),
stashes it in a short-lived `rp_oauth_state` cookie (`Max-Age=600`, 10
min), and 302-redirects to Google's consent screen
(`accounts.google.com/o/oauth2/v2/auth`). The request asks for scopes
`openid email profile`, with `access_type=online` (deliberately **no**
offline access → no refresh tokens) and `prompt=select_account` so the
user always gets the account picker.

If OAuth isn't configured (`state.oauth == None`), this returns **503**
`oauth_disabled` rather than building a broken redirect.

### 2. `GET /api/auth/google/callback?code=…&state=…`

The heavy lifting. In order:

1. **CSRF check.** The `state` query param must byte-match the
   `rp_oauth_state` cookie set in `/start`. A missing/expired cookie is
   `oauth_no_state_cookie`; a mismatch is `oauth_state_mismatch`. Google's
   own `?error=…` (user denied consent) short-circuits to `oauth_denied`.
2. **Token exchange.** POST `code` + client id/secret + redirect URI to
   `oauth2.googleapis.com/token` with `grant_type=authorization_code`.
   A non-2xx from Google maps to `oauth_token_rejected` (400).
3. **Userinfo fetch.** GET `openidconnect.googleapis.com/v1/userinfo`
   with the access token as a bearer. We read the claims from the
   userinfo endpoint rather than decoding the `id_token` JWT — a one-line
   GET against the documented source of truth, no JWT verification code to
   own. (`id_token` is parsed off the token response but otherwise
   unused.)
4. **Upsert + default project.** `db::upsert_google_user` matches on
   Google's `sub` (stable across email/name changes — never match on
   email, users can change it). `db::ensure_default_project` then
   guarantees a brand-new account lands on a usable workspace *before*
   its first navigation; it's idempotent for returning users.
5. **Session mint.** `db::create_session` writes a session row with a
   30-day TTL (`SESSION_TTL_DAYS`). The callback clears `rp_oauth_state`,
   sets `rp_session`, and 302s to `/`. An `auth_login` audit event is
   emitted, attributed to the user + new session.

### 3. `POST /api/auth/logout`

Resolves the user from the session cookie **before** deleting the row (so
the `auth_logout` event stays attributed), deletes the session via
`db::delete_session`, clears the cookie, returns 204.

## Cookies

| Name | TTL | Purpose |
|------|-----|---------|
| `rp_oauth_state` | 10 min | One-shot CSRF token bridging `/start` → `/callback`. HttpOnly, SameSite=Lax. |
| `rp_session` | 30 days | The session ID (`SES_…`). HttpOnly, SameSite=Lax. Cleared on logout. |

Both are minted with `SameSite=Lax` and **without** the `Secure`
attribute — the code targets HTTP dev today. `Secure` must be turned on
when the deployment lands behind HTTPS (the cookie helpers in `auth.rs`
are the single place to flip it). The client cookie's `Max-Age` is kept
in lock-step with `SESSION_TTL_DAYS` so the browser cookie and the DB row
expire together.

## Configuration gate

The flow needs all three env vars — `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`. They're read
into `state.oauth` at startup (see [state](../code/backend/api/state.md)).
If any is missing, `state.oauth` is `None`, the Google routes 503, and the
app falls back to the [dev-user / bootstrap](dev-user.md) path. Local dev
and CI run this way by default; the registered redirect URI for local dev
is `http://localhost:8080/api/auth/google/callback`.

## Session storage & lifecycle

Sessions are rows keyed by `redpash_id`, carrying `user_redpash_id`,
`expires_at`, `created_at`. The lookup path (`find_session_user`)
auto-deletes expired rows on read, so the table garbage-collects itself
without a sweep job. `resolve_user_rid` (in `routes::me`) is the single
"who is this request for?" resolver: it reads `rp_session`, looks up the
session user, and only falls back to `dev_user` when OAuth is disabled.

## What is deliberately NOT here

- **Refresh tokens** — `access_type=online`, so an expired session means a
  fresh Google sign-in, not a silent refresh.
- **Account linking** — one Google `sub` = one RedPash user. A first-time
  email collision would hit the `users.email` unique index; the upsert
  matches on `sub`, not email.
- **`Secure` cookies** — off until HTTPS (see Cookies above).
- **Userinfo edge cases** — `email` is always present (we request the
  scope); `name`/`picture` are optional, and a missing `name` falls back
  to the email local part for the display name.

## Source files

- [`code/backend/api/routes/auth.md`](../code/backend/api/routes/auth.md) — the three OAuth handlers + cookie/CSRF helpers.
- [`code/backend/api/routes/me.md`](../code/backend/api/routes/me.md) — `resolve_user_rid`, the session→user resolver.
- [`code/backend/api/db/sessions.md`](../code/backend/api/db/sessions.md) — `create_session` / `find_session_user` / `delete_session` + expiry GC.
- [`code/backend/api/db/users.md`](../code/backend/api/db/users.md) — `upsert_google_user` (matches on `google_sub`).
- [`code/backend/api/db/projects.md`](../code/backend/api/db/projects.md) — `ensure_default_project`, the per-user workspace.
- [`code/backend/api/state.md`](../code/backend/api/state.md) — `state.oauth` config gate + `state.dev_user` fallback.
