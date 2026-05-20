---
title: Auth
section: API
order: 3
last modified date: 2026-05-16
---

# `/api/auth/*`

Google OAuth 2.0 authorization-code flow. Three endpoints:
`/google/start`, `/google/callback`, `/logout`.

**Route file:** [`crates/api/src/routes/auth.rs`](../../backend/crates/api/src/routes/auth.rs)
**Full walkthrough:** [auth/google.md](../auth/google.md)
**Shipped in:** Phase 4a (flow), Phase 4b (per-user data scoping)

When the `GOOGLE_OAUTH_*` env vars are unset the auth routes return
**503 oauth_disabled**, and the rest of the app stays on the bootstrap
`dev_user`. This is the supported local-dev mode — no Google project
needed.

---

## `GET /api/auth/google/start`

Kick off sign-in. Mints a random CSRF `state` token, stashes it in a
short-lived `rp_oauth_state` HttpOnly cookie (10 min Max-Age), and
302-redirects to Google's consent screen with our `client_id`,
`redirect_uri`, `scope=openid email profile`, and the freshly-minted
`state`.

The frontend's landing page hits this with a plain
`<a href="/api/auth/google/start">` — no XHR, no JSON body.

### Errors

| Status | `kind`           | When |
|--------|------------------|------|
| 503    | `oauth_disabled` | `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` not all set |

---

## `GET /api/auth/google/callback?state=…&code=…`

Where Google redirects after consent. The handler:

1. Reads `rp_oauth_state` cookie → must equal the `state` query param
   (CSRF check).
2. POST `oauth2.googleapis.com/token` to exchange `code` for an access
   token (via `state.http` — a shared `reqwest::Client` with
   `rustls-tls`).
3. GET `openidconnect.googleapis.com/v1/userinfo` with that bearer
   token → claims `{sub, email, name?, picture?}`.
4. `db::upsert_google_user` — match on `google_sub`, INSERT on miss
   (mint a fresh `USR_…`), UPDATE on hit (refresh email / display_name
   / avatar_url).
5. `db::ensure_default_project` — idempotent; new users get their
   `"Workspace"` project here, returning users no-op.
6. `db::create_session` — INSERT a `sessions` row with a new
   `SES_…` id and an `expires_at` 30 days out.
7. Set-Cookie:
   - `rp_oauth_state=; Max-Age=0` (clear the state cookie).
   - `rp_session={sid}; HttpOnly; Path=/; SameSite=Lax;
     Max-Age=2592000`.
8. 302 → `/`.

### Errors

| Status | `kind`                          | When |
|--------|---------------------------------|------|
| 400    | `oauth_denied`                  | User clicked "Cancel" — Google returns `?error=access_denied` |
| 400    | `oauth_no_code`                 | No `code` in the query string |
| 400    | `oauth_no_state`                | No `state` in the query string |
| 400    | `oauth_no_state_cookie`         | State cookie missing or already expired (>10 min round-trip) |
| 400    | `oauth_state_mismatch`          | CSRF check failed — `state` query ≠ cookie |
| 400    | `oauth_token_rejected`          | Google rejected the code exchange (bad client_secret, expired code…) |
| 500    | `oauth_token_request` / `…_decode` / `…_userinfo_*` | Network or decode failure against Google |
| 503    | `oauth_disabled`                | Same as `/start` — config missing |

`redirect_uri_mismatch` from Google is a 400 with
`kind="oauth_token_rejected"` and the Google error string in
`message`. The fix is in [auth/google.md](../auth/google.md) —
the `GOOGLE_OAUTH_REDIRECT_URI` value must exactly match an Authorized
Redirect URI in the Google Cloud Console.

---

## `POST /api/auth/logout`

Deletes the session row and clears the cookie.

```http
POST /api/auth/logout
Cookie: rp_session=SES_…
```

```jsonc
204 No Content
Set-Cookie: rp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0
```

Idempotent — calling it without a session cookie still succeeds and
still emits the clear-cookie header. There's no body; the response
status is 204.

The Sign out item in the top-bar user-menu dropdown calls this
(`frontend/scripts/main.js::renderTopbar`). You can also invoke it
manually:

```bash
curl -X POST http://localhost:8080/api/auth/logout \
  -b "rp_session=$YOUR_SID" -i
```

---

## Cookies (canonical reference)

| Cookie             | Set by              | Max-Age   | Flags                                | Purpose |
|--------------------|---------------------|-----------|--------------------------------------|---------|
| `rp_oauth_state`   | `/google/start`     | 600s      | HttpOnly · Path=/ · SameSite=Lax     | CSRF token; cleared on `/callback` |
| `rp_session`       | `/google/callback`  | 2592000s  | HttpOnly · Path=/ · SameSite=Lax     | Session id — consulted by `resolve_user_rid` |

Both cookies omit `Secure` in dev (HTTP). Flip on when the deployment
lands behind HTTPS — see the inline comment in `session_cookie()` in
`routes/auth.rs`.

---

## Related

- [me.md](me.md) — how `rp_session` is consumed by `resolve_user_rid`.
- [objects/user.md](../objects/user.md) — `users` schema + `google_sub`.
- [auth/google.md](../auth/google.md) — env vars + Google Cloud Console setup.
