---
title: backend/crates/api/src/bootstrap.rs
source: ../../../../../backend/crates/api/src/bootstrap.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-06-14
---

# bootstrap.rs

## Purpose

Startup-time idempotent setup.

Runs after migrations. Ensures the dev user + their default project
exist so the upload pipeline always has somewhere to put files. Once
Phase 4 (Google OAuth) ships, this falls back to a no-op when at
least one human user already exists.

## Admin promotion

The bootstrap/dev user is always promoted to `users.role = 'admin'` (the
dev-mode RBAC bypass, `rbac::is_platform_admin`). Beyond that, the
**`REDPASH_BOOTSTRAP_ADMINS`** env var (CAS_D78667D1) is a comma-separated
allowlist of `redpash_id` **or** `username` tokens; each is promoted
idempotently on every boot (`UPDATE … WHERE (redpash_id=$1 OR username=$1)
AND role <> 'admin'`). This is the no-psql path for founders / additional
Torvs — without it a real (non-dev) login sees empty list pages because RBAC
strips rows for a caller with no platform-admin role. Unknown tokens are a
no-op (0 rows); promotions log at INFO only when a role actually flips. The
UI-driven promotion endpoint is the sibling follow-up (same case, option b).

## Public surface

- `pub struct Bootstrap` — struct
- `pub fn run` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
