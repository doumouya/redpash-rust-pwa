---
title: backend/crates/api/src/routes/mod.rs
source: ../../../../../../backend/crates/api/src/routes/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# mod.rs

## Purpose

Route assembly.

Each resource is its own module (`health`, `files`, …) and exposes a
`pub fn routes() -> Router<AppState>` that gets nested under its URL
prefix here. Keeping the tree assembled in one place makes the API
surface easy to audit.

## Public surface

- `pub fn router` — function

## Drift-prone areas

- **`require_platform_admin_mw`** (CAS_274EDF3B) — a `from_fn_with_state` layer on
  the `/monitoring` nest gates the WHOLE router on `is_platform_admin` (leak-free
  404 for non-admins) before any handler runs. Auto-covers every current/future
  `/monitoring/*` route — no per-handler gate to add. To make another nested
  router admin-only, apply the same layer (clone the state for it, like
  `mon_admin_state`).
- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- The static `ServeDir` fallback carries `cache-control: no-cache` under `#[cfg(debug_assertions)]` so dev frontend edits revalidate on a normal reload ([runbook 0009](../../../../runbooks/CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md)). The layer wraps the *service*, not the router, to keep `/api/*` uncached — don't move it onto the outer router.
- 2026-05-31: `teams` module mounted under `/api/teams` next to `/api/companies` for the teams CRUD slice — see [teams](teams.md).

## Related

- [Backend pillar landing](../../index.md)
