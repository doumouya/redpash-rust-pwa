# Auth — dev-user / bootstrap / first-admin claim

The dev-user path lets you obtain a session with no Google account, no credentials, and no
consent screen. It exists so the app is usable the moment the binary starts (before OAuth
is configured) and so headless tooling can drive the live frontend without a browser-MCP
login dance.

It is two pieces that work together: a **bootstrap user** the server ensures exists, and a
**dev-login route** that mints a session for it on demand. Both are **compiled out of
release builds entirely** — they are `#[cfg(debug_assertions)]`, not a runtime env flag.
That is [day-one decision #10](../../decisions/day-one.md): dev-login is compile-profile-gated,
so a release binary has no fallback identity to forget to disable.

This doc was **restored on lean**; it lived at `docs/internal/auth/dev-user.md` on
`prerelease` and was dropped in the graduation. The prerelease shape gated dev-login behind
a `REDPASH_DEV_LOGIN` env var and promoted admins via a `REDPASH_BOOTSTRAP_ADMINS`
allowlist — **both are gone on lean**. The env gate became a `cfg` gate, and the admin
allowlist became the `POST /api/auth/claim-admin` route. Specifics below are verified
against the lean tree.

Source: [`auth.rs`](../../../backend/crates/api/src/auth.rs) (the dev-login route + the
claim-admin route) and [`bootstrap.rs`](../../../backend/crates/api/src/bootstrap.rs) (the
ensure-`dev`-user step).

## The bootstrap user (debug builds only)

The whole [`bootstrap`](../../../backend/crates/api/src/bootstrap.rs) module is
`#![cfg(debug_assertions)]` — it does not exist in a release binary. On startup
([`state.rs`](../../../backend/crates/api/src/state.rs), in `AppState::init`),
`bootstrap::ensure_dev_user` runs and:

- ensures a user with username `dev` exists, creating it if missing — and creating it
  **directly as `users.role = 'admin'`** (the `INSERT … VALUES ($1, 'dev', 'Dev user',
  'admin')`), inside one transaction that first writes the `entities` registry row via
  `db::register_entity`. There is no separate promote step — the dev user is born an admin;
  the lookup-or-insert is idempotent across boots.
- ensures a default project for it (`db::ensure_default_project`).

Its RID is stashed on `AppState.dev_user` (an `Arc<String>`, **debug builds only**) — that
is the RID the dev-login route falls back to when no specific user is asked for. This is
also why a freshly-started dev app is never "empty": even with zero human logins there's a
user and a project for the upload pipeline to target.

The `admin` role is what makes the RBAC platform-admin bypass
([`rbac.rs`](../../../backend/crates/api/src/rbac.rs), `caller.is_platform_admin`) work in
dev — list pages return all rows instead of the empty, RBAC-stripped view a non-admin sees.

## POST /api/auth/dev-login (debug builds only)

The route is added to the auth router **only under `#[cfg(debug_assertions)]`**
(`routes()` in [`auth.rs`](../../../backend/crates/api/src/auth.rs)). In a release build the
route, its handler, and its body type are not compiled at all — there is no
`dev_login_disabled` 403 path because there is no route to hit. This is stronger than a
runtime flag: you cannot accidentally enable it in production by setting an env var,
because the code isn't there.

It mints a session and sets the `rp_session` cookie. The body is extracted as raw
`axum::body::Bytes` (not `Json<T>`), so a no-body POST isn't rejected with `415` on a
missing `Content-Type`. Two call shapes:

- **No body** (`body.is_empty()`) → session for `state.dev_user`. This is the "Continue as
  dev user" path; the caller never needs to know any specific RID.
- **`{ "user_id": "USR_…" }`** → session for that user. (`user_id` omitted falls back to
  `state.dev_user` too.) This powers the "log in as user" switcher used to test
  owner-scoped flows without juggling Google accounts.

Either way the target RID must resolve to a real user row via `db::find_user_by_id`,
otherwise the route returns `404 not_found` ("user not found") rather than minting a
session pointing at a phantom RID. The minted session is a normal 30-day
(`SESSION_TTL_DAYS`) row from `db::create_session` — identical to one produced by the
Google callback; there is no second-class "dev session" type. On success it returns `204`
with a `Set-Cookie: rp_session=…` (`HttpOnly`, `SameSite=Lax`, and `Secure` only in
release — the same single Secure flip point, on in release / off in debug, day-one #10).

## Who uses dev-login

dev-login is the standing render-proof recipe for driving the live FE with no
auth/MCP login dance. On lean the consumer that survives is the **MCP-server cases
bridge** (`tools/mcp-server/dist/cases.js`): it self-mints a session by POSTing the no-body
shape to `/api/auth/dev-login`, captures the `Set-Cookie: rp_session=…`, and re-uses it for
the cases API; a mint-coalescer keeps concurrent tool calls sharing one round-trip. If
dev-login isn't reachable (e.g. against a release binary), the bridge can't log in. Any
headless live-render check follows the same shape: it depends on running a **debug** build.

## First-admin claim — POST /api/auth/claim-admin

`bootstrap::ensure_dev_user` only auto-admins the `dev` user, and only in debug. A real
human who signs in through Google OAuth — in any build — lands as a non-admin and, because
RBAC strips rows a non-platform-admin can't see, sees empty list pages. The first real
account is not magically an admin just because it's first.

The escape hatch is the **`POST /api/auth/claim-admin`** route (always compiled, in both
debug and release), not the dev-login route. It replaces the prerelease
`REDPASH_BOOTSTRAP_ADMINS` env allowlist:

- It takes the authenticated `Caller` (no body) and calls `db::claim_first_admin`, which is
  an atomic `UPDATE users SET role = 'admin' WHERE redpash_id = $1 AND NOT EXISTS (SELECT 1
  FROM users WHERE role = 'admin')`. So **exactly one** caller can win — the first
  authenticated user to call it while no admin exists becomes one; the SQL guarantees there
  is no race.
- On a win it logs a `warn!` ("first platform admin claimed") and returns `200 {claimed:
  true}`. The caller's cached `(rid, is_admin)` tuple is briefly stale; the short Caller
  cache TTL self-corrects.
- If an admin already exists it returns **leak-free `404 not_found`** ("nothing to claim") —
  it answers exactly like a wrong route, so a probe can't tell whether the install already
  has an admin.

Subsequent admins are granted by an existing admin through the admin surface, not by this
route. The dev-login route itself does no promotion — it only mints sessions for users that
already exist with whatever role they already have.

## Source files

- [`auth.rs`](../../../backend/crates/api/src/auth.rs) — the `dev_login` handler + its
  `#[cfg(debug_assertions)]` route registration, the `claim_admin` handler, body parsing,
  cookie helpers, and the single `SECURE_ATTR` flip point, alongside the Google OAuth flow.
- [`bootstrap.rs`](../../../backend/crates/api/src/bootstrap.rs) — the
  `#![cfg(debug_assertions)]` `ensure_dev_user`: ensure-`dev`-user-as-admin +
  default project.
- [`state.rs`](../../../backend/crates/api/src/state.rs) — where `dev_user` (debug-only
  fallback RID) is resolved into `AppState` at startup.
- [`db.rs`](../../../backend/crates/api/src/db.rs) — `find_user_by_id` / `create_session`
  (used to mint the session), `register_entity` / `ensure_default_project` (used by
  bootstrap), and `claim_first_admin` (the atomic first-admin guard).
- [`api-routes.md`](../code/backend/api-routes.md) — the HTTP route catalog, including the
  `/auth/dev-login` and `/auth/claim-admin` rows.
- [`day-one.md`](../../decisions/day-one.md) — decision #10 (dev-login compile-profile-gated,
  one Secure/CSRF flip point, first-admin claim over an env allowlist).
