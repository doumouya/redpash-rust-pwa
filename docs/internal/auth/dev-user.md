---
title: Auth — dev-user / bootstrap
section: Internal
last modified date: 2026-06-07
---

# Auth — dev-user / bootstrap

The dev-user path lets you obtain a session with no Google account, no
credentials, and no consent screen. It exists so the app is usable the
moment the binary starts (before OAuth is configured) and so headless
tooling — chiefly `tools/page-verify` — can drive the live frontend
without a browser-MCP login dance.

It is two pieces that work together: a **bootstrap user** the server
always ensures exists, and a **dev-login route** that mints a session
for it on demand.

## The bootstrap user

On every startup, after migrations, `bootstrap::run` ensures a user with
username `dev` exists (creating it if missing) and a default project for
it. The bootstrap user's RID is stashed on `AppState.dev_user` — that's
the RID the dev-login route falls back to when no specific user is asked
for. This is also why the app is never "empty": even with zero human
logins there's a user and a project for the upload pipeline to target.

The bootstrap step **also promotes the `dev` user to `users.role =
'admin'`** (idempotent `UPDATE ... WHERE role <> 'admin'`). That admin
role is what makes the RBAC platform-admin bypass (`rbac::is_platform_admin`)
work in dev — list pages return all rows instead of the empty,
RBAC-stripped view a non-admin sees.

## POST /api/auth/dev-login

Mints a session and sets the `rp_session` cookie. It is **gated behind
`AppState.dev_login`**, read from the `REDPASH_DEV_LOGIN` env flag at
startup. Off by default; when the flag is unset the route returns `403
dev_login_disabled`. When the flag IS set, startup logs a `warn!` —
this is a deliberate **unauthenticated session mint and must never be
enabled in production.**

Two call shapes, distinguished by the request body (extracted as raw
`Bytes`, not `Json<T>`, so a no-body POST isn't rejected with 415 on a
missing `Content-Type`):

- **No body** (or `{}`, or a body with `user_id` omitted) → session for
  `state.dev_user`. This powers the login page's "Continue as dev user"
  button; the frontend never needs to know any specific RID.
- **`{ "user_id": "USR_…" }`** → session for that user. This powers the
  Home header's "log in as user" switcher, used to test owner-scoped
  flows (project reassignment, company membership, …) without juggling
  Google accounts.

Either way the target RID must resolve to a real user row, otherwise the
route returns `404 not_found` rather than minting a session pointing at a
phantom RID. The minted session is a normal 30-day (`SESSION_TTL_DAYS`)
session row, identical to one produced by the Google callback — there is
no second-class "dev session" type.

## Used by page-verify

`tools/page-verify` renders the live FE with no auth/MCP by setting
`REDPASH_DEV_LOGIN=1` and POSTing the no-body shape to `/api/auth/dev-login`
to obtain the cookie before navigating. This is the standing
render-proof recipe; if dev-login is disabled, page-verify can't log in.

## The bootstrap promotion gap

**Only the `dev` user is auto-promoted to admin.** A real human who
signs in through Google OAuth lands as a non-admin and — because RBAC
strips rows a non-platform-admin can't see — sees empty list pages. This
is the gap noted across cases: the first real account is not magically an
admin just because it's first.

The escape hatch lives in `bootstrap::run`, not in this route:
`REDPASH_BOOTSTRAP_ADMINS` is a comma-separated list of `redpash_id` OR
`username` values, each promoted to admin idempotently on every boot
(unknown tokens are a no-op). That's how Em's real Google account or
another agent gets admin without a `psql` one-liner (CAS_D78667D1). The
dev-login route itself does no promotion — it only mints sessions for
users that already exist with whatever role they already have.

## Source files

- [`../code/backend/api/routes/auth.md`](../code/backend/api/routes/auth.md)
  — the `dev_login` handler, the `REDPASH_DEV_LOGIN` gate, body parsing,
  cookie helpers (alongside the Google OAuth flow).
- [`../code/backend/api/bootstrap.md`](../code/backend/api/bootstrap.md)
  — startup ensure-`dev`-user + admin promotion + `REDPASH_BOOTSTRAP_ADMINS`
  allowlist.
- [`../code/backend/api/state.md`](../code/backend/api/state.md)
  — where `dev_user` (the fallback RID) and `dev_login` (the flag) are
  resolved into `AppState`.
- [`../code/backend/api/db/index.md`](../code/backend/api/db/index.md)
  — `find_user_by_id` / `create_session` used to mint the session.
