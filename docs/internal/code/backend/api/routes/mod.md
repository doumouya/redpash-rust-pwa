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

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- The static `ServeDir` fallback carries `cache-control: no-cache` under `#[cfg(debug_assertions)]` so dev frontend edits revalidate on a normal reload ([runbook 0009](../../../../runbooks/CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md)). The layer wraps the *service*, not the router, to keep `/api/*` uncached — don't move it onto the outer router.

## Related

- [Backend pillar landing](../../index.md)
