# Auth — Google OAuth

The production sign-in path. A full OAuth 2.0 **authorization-code** flow
where the backend does all the work: it talks to Google, mints a session
row, and hands the browser a single HttpOnly `rp_session` cookie. The
frontend never sees a Google token — it only ever knows whether it has a
session. There are no refresh tokens; when a session expires the user
re-authenticates against Google.

All handlers live in
[`backend/crates/api/src/auth.rs`](../../../backend/crates/api/src/auth.rs).
This doc was **restored on lean** — it had lived under `docs/internal/auth/`
on prerelease and was dropped in the graduation. The flow is ported
near-verbatim from the predecessor (userinfo-over-JWT, upsert-by-`sub`, no
refresh tokens, opaque `rp_session`), with the
[day-one #10](../../decisions/day-one.md) hardening that the rest of this
doc calls out where it bites.

## Why backend-minted sessions

Keeping the OAuth exchange server-side means Google access tokens never
touch JavaScript or `localStorage`. The browser's only credential is an
opaque session ID (`SES_…`) in an HttpOnly cookie it cannot read — the
"Rust owns data, JS owns pixels" boundary applied to auth: the backend owns
identity, the frontend owns pixels.

## The flow (two requests + Google)

The routes are mounted under `/api` (`auth::routes()` is nested at `/auth`),
so the live paths are `/api/auth/google/start`, `/api/auth/google/callback`,
and `/api/auth/logout`.

### 1. `GET /api/auth/google/start`

Mints a random CSRF `state` token — two concatenated
`uuid::Uuid::new_v4().simple()` forms, so a 64-hex-char body carrying
~244 bits of randomness (122 bits per UUID-v4) — stashes it in a
short-lived `rp_oauth_state` cookie (`Max-Age=600`, 10 min), and
302-redirects to Google's consent screen
(`accounts.google.com/o/oauth2/v2/auth`). The redirect URL carries
`client_id`, `redirect_uri`, `response_type=code`, scopes
`openid email profile`, the `state` token, `access_type=online`
(deliberately **no** offline access → no refresh tokens), and
`prompt=select_account` so the user always gets the account picker. The
client secret is **not** sent here — it only appears in the server-to-server
token exchange in step 2.

If OAuth isn't configured (`state.oauth == None`), `oauth_cfg` returns
**503** `oauth_disabled` rather than building a broken redirect.

### 2. `GET /api/auth/google/callback?code=…&state=…`

The heavy lifting. In order:

1. **CSRF check.** Google's own `?error=…` (user denied consent)
   short-circuits to `oauth_denied` (400) first. Then a missing `code` is
   `oauth_no_code` and a missing `state` is `oauth_no_state` (both 400). The
   `state` query param must byte-match the `rp_oauth_state` cookie set in
   `/start`: a missing/expired cookie is `oauth_no_state_cookie`; a mismatch
   is `oauth_state_mismatch`.
2. **Token exchange.** POST `code` + client id/secret + redirect URI to
   `oauth2.googleapis.com/token` with `grant_type=authorization_code`. A
   non-2xx from Google maps to `oauth_token_rejected` (400); a transport
   failure or a decode failure is a 500 (`oauth_token_request` /
   `oauth_token_decode`).
3. **Userinfo fetch.** GET `openidconnect.googleapis.com/v1/userinfo` with
   the access token as a bearer. We read the claims from the userinfo
   endpoint rather than decoding the `id_token` JWT — a one-line GET against
   the documented source of truth, no JWT verification code to own. (The
   token response itself is deserialized only for `access_token`.)
4. **Upsert + default project.** `db::upsert_google_user` matches on
   Google's `sub` (`users.google_sub`, stable across email/name changes —
   never match on email, users can change it); a returning user has email /
   display name / avatar refreshed, a new user is minted a `USR_` rid +
   registry row. `db::ensure_default_project` then guarantees a brand-new
   account lands on a usable workspace *before* its first navigation; it's
   idempotent for returning users.
5. **Session mint.** `db::create_session` writes a `SES_…` session row with
   a 30-day TTL (`SESSION_TTL_DAYS`). The callback clears `rp_oauth_state`,
   sets `rp_session`, and 302s to `/`.

### 3. `POST /api/auth/logout`

Reads the session cookie, deletes the row via `db::delete_session`, evicts
the cached verdict (`session::invalidate` — see [Session cache](#session-cache--lifecycle)),
clears the cookie, returns 204. A request with no session cookie still
returns 204 (idempotent).

## Cookies

| Name | TTL | Purpose |
|------|-----|---------|
| `rp_oauth_state` | 10 min | One-shot CSRF token bridging `/start` → `/callback`. HttpOnly, SameSite=Lax. |
| `rp_session` | 30 days | The session ID (`SES_…`). HttpOnly, SameSite=Lax. Cleared on logout. |

The client cookie's `Max-Age` is kept in lock-step with `SESSION_TTL_DAYS`
(`SESSION_TTL_DAYS * 24 * 3600` seconds) so the browser cookie and the DB
row expire together.

### The `Secure` flip — one compile-profile point

Both cookies are minted `SameSite=Lax` with the `Secure` attribute driven by
a **single compile-profile constant**, not a runtime env var
([day-one #10](../../decisions/day-one.md)):

```rust
// auth.rs
#[cfg(debug_assertions)]
const SECURE_ATTR: &str = "";          // HTTP dev — no Secure
#[cfg(not(debug_assertions))]
const SECURE_ATTR: &str = "; Secure";  // release — Secure always on
```

So a debug build (local dev / CI over HTTP) ships cookies without `Secure`,
and a release build ships them with it — there is **no env var to forget**,
which is the predecessor failure this hardening closes. `SECURE_ATTR` is
appended by all three cookie helpers (`session_cookie`, `clear_cookie`, and
the inline `rp_oauth_state` mint), so it is the one place the attribute is
decided.

## Configuration gate

The flow needs all three env vars — `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`. They're read into
`state.oauth` (an `Option<Arc<OAuthConfig>>`) at startup via
`env_nonempty`. If **any** is missing, `state.oauth` is `None`, the Google
routes 503 `oauth_disabled`, and a debug build falls back to the dev
bootstrap path (below). Local dev and CI run this way by default; the
registered redirect URI for local dev is
`http://localhost:8080/api/auth/google/callback`.

## Session cache & lifecycle

Sessions are rows keyed by their `SES_…` id, carrying `user_id` and
`expires_at`. `db::find_session_user` auto-deletes an expired row on read,
so the table garbage-collects itself without a sweep job.

Who-is-this-request-for? is answered once per request by the `Caller`
extractor (`FromRequestParts` in
[`session.rs`](../../../backend/crates/api/src/session.rs)), not by a
helper handlers call by hand. It reads `rp_session`, resolves the session
user, looks up `is_platform_admin`, and **caches the `(rid, is_admin)`
verdict behind a 60s TTL** (`SESSION_CACHE_TTL`) so repeated requests in the
window do zero auth queries — the predecessor ran ~5 auth queries per file
PATCH. Logout and role changes evict eagerly via `session::invalidate`;
otherwise the 60s TTL self-corrects. Any endpoint that takes `Caller` cannot
forget auth: in a release build, a missing/expired session is a typed 401
before the handler body runs.

## Dev bootstrap (debug builds only)

The dev fallback is **compiled out of release binaries** — it is `#[cfg(debug_assertions)]`,
not a runtime flag ([day-one #10](../../decisions/day-one.md); the
predecessor's env-gated dev-login meant a single mis-set var could mint any
user's session in production):

- `POST /api/auth/dev-login` (debug only) takes an optional `{user_id?}`
  (empty body → the bootstrap dev user), mints a real `rp_session`, returns
  204. The route literally does not exist in a release `Router`.
- The `Caller` extractor, in a debug build, falls back to `state.dev_user`
  (always a platform admin) when there is no live session — so local dev
  needs zero auth setup. In release that same branch is a 401.

## First-admin claim

`POST /api/auth/claim-admin` replaces the predecessor's
`REDPASH_BOOTSTRAP_ADMINS` env escape hatch. The first authenticated caller
to hit it **while no admin exists** becomes one — `db::claim_first_admin` is
atomic, so exactly one caller wins. An install that already has an admin
answers with a **leak-free 404** (`not_found`), identical to a wrong route,
so a probe can't detect admin presence. Subsequent admins are granted
through the admin surface, not this route.

## What is deliberately NOT here

- **Refresh tokens** — `access_type=online`, so an expired session means a
  fresh Google sign-in, not a silent refresh.
- **Account linking** — one Google `sub` = one RedPash user. The upsert
  matches on `google_sub` (the only identity-bearing unique column on
  `users`); `email` is intentionally **not** uniquely constrained, so two
  Google accounts that share an email stay distinct rows keyed by `sub`
  rather than silently merging. New users get a `username` derived from the
  email local part, and *that* column **is** `UNIQUE` — a local-part
  collision is the one that surfaces as a constraint error.
- **JWT verification** — claims come from the userinfo endpoint; the
  `id_token` is never decoded, so there's no signature-verification code to
  own.
- **A runtime `Secure` / dev-login flag** — both are compile-profile
  decisions (day-one #10); there is no env var to mis-set.
- **Userinfo edge cases** — `email` is always present (we request the
  scope); `name`/`picture` are optional, and a missing `name` falls back to
  the email local part for the display name.

## Source files

- [`backend/crates/api/src/auth.rs`](../../../backend/crates/api/src/auth.rs)
  — the OAuth handlers (`start` / `callback` / `logout` / `claim_admin` /
  debug-only `dev_login`) + the cookie/CSRF helpers and the `SECURE_ATTR`
  flip point.
- [`backend/crates/api/src/session.rs`](../../../backend/crates/api/src/session.rs)
  — the `Caller` extractor: session → user verdict, the 60s TTL cache, and
  `invalidate`.
- [`backend/crates/api/src/db.rs`](../../../backend/crates/api/src/db.rs) —
  `upsert_google_user` (matches on `google_sub`), `ensure_default_project`,
  `create_session` / `find_session_user` (expiry GC) / `delete_session`,
  `claim_first_admin`.
- [`backend/crates/api/src/state.rs`](../../../backend/crates/api/src/state.rs)
  — the `state.oauth` config gate (`OAuthConfig`), `SESSION_CACHE_TTL`, and
  the `state.dev_user` fallback.
- [`api-routes.md`](../code/backend/api-routes.md) — the `/api/auth/*` route
  table in the wider HTTP catalog.
- [`redpash-id.md`](../code/backend/redpash-id.md) — the `SES_` / `USR_` rid
  scheme these handlers mint.
