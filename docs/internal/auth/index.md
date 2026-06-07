---
title: Auth — internal
section: Internal
last modified date: 2026-06-07
---

# Auth

How a user becomes a session. Two paths.

> Migrating in (CAS_701CF65E): `google.md` ports from `docs/auth/google.md`;
> `dev-user.md` is written from the bootstrap reality. Phase C.

## Paths

- **Google OAuth** ([google.md](google.md)) — the production sign-in.
- **Dev-user / bootstrap** ([dev-user.md](dev-user.md)) — `REDPASH_DEV_LOGIN=1`
  + `POST /api/auth/dev-login`; the only path that mints the `dev` admin
  (bootstrap promotion gap noted in cases). Used by `tools/page-verify`.

## How a session flows

login → `/api/me` → `seedPrefs` → first paint. The end-to-end trace ports
here from the old `flows/auth-session-prefs.md`.

## Source files

- [`code/backend/api/`](../code/index.md) — the auth routes + session middleware.
- [`code/frontend/scripts/api.md`](../code/index.md) — the client session bootstrap.
