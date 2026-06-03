---
title: backend/crates/api/src/routes/mod.rs
source: ../../../../../../backend/crates/api/src/routes/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-03
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

- **`require_platform_admin_mw`** (CAS_274EDF3B) — a `from_fn_with_state` layer that gates a
  nest on `is_platform_admin` (leak-free 404 for non-admins) before any handler runs. Applied
  to THREE nests, each with its own cloned state: `/monitoring` (`mon_admin_state`), `/admin`
  (`admin_gate_state`, commit `74f85cc`), and `/metrics` (`metrics_admin_state`, 2026-06-03 —
  was anonymously readable, runbook
  [CAS_CBA057EE…](../../../../runbooks/CAS_CBA057EE46F24BAD897089D2B9DDBDFC-metrics-anon-leak.md)).
  Auto-covers every current/future route under each — no per-handler gate to add. The gate's
  presence is an **asserted invariant**: `tools/list-endpoint-rbac-audit` (`EXPECT_NEST_GATE`)
  goes RED if a layer is removed. To gate another nest, clone the state + apply the same layer.
- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- The static `ServeDir` fallback carries `cache-control: no-cache` under `#[cfg(debug_assertions)]` so dev frontend edits revalidate on a normal reload ([runbook 0009](../../../../runbooks/CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md)). The layer wraps the *service*, not the router, to keep `/api/*` uncached — don't move it onto the outer router.
- 2026-05-31: `teams` module mounted under `/api/teams` next to `/api/companies` for the teams CRUD slice — see [teams](teams.md).

## Related

- [Backend pillar landing](../../index.md)
