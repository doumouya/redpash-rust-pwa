---
title: backend/crates/api/src/routes/auth.rs
source: ../../../../../../backend/crates/api/src/routes/auth.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# auth.rs

## Purpose

`/api/auth/google/*` — full OAuth 2.0 authorization-code flow.

Sequence:
1. `GET  /api/auth/google/start`
Mint a random `state` token, stash it in a short-lived
`rp_oauth_state` cookie, redirect to Google's consent screen.
2. `GET  /api/auth/google/callback?state=…&code=…`
Verify `state` matches the cookie. Exchange `code` for tokens
against `oauth2.googleapis.com`. Fetch the userinfo claims.
Upsert the user by `google_sub`. Create a session row, set
an HttpOnly `rp_session` cookie, redirect to `/`.
3. `POST /api/auth/logout`
Delete the session row and clear the cookie.

## Public surface

- `pub fn routes` — function
- `pub fn read_cookie` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
