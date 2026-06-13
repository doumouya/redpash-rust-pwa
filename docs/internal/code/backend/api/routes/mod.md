---
title: backend/crates/api/src/routes/mod.rs
source: ../../../../../../backend/crates/api/src/routes/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-13
---

# mod.rs

## Purpose

Route assembly.

Each resource is its own module (`health`, `files`, …) and exposes a
`pub fn routes() -> Router<AppState>` that gets nested under its URL
prefix here. Keeping the tree assembled in one place makes the API
surface easy to audit.

**Lean slim (CAS_C8A9):** the SaaS-only route nests were removed — `demo`,
`docs`, `companies`, `teams`, `users` (modules + `.nest` + `routes/<name>.rs`),
and `members` (nested under cases/projects; module deleted with its callers). The
DB tables those routes touched **stay** (admin/monitoring SQL still joins them);
only the route surface was cut. `cases` was trimmed to just `/cases/categories`
(the Monitoring CATALOG tab) — see [cases](cases.md). `admin` is kept whole
(monitoring needs `/admin/users` + `/admin/steps/stats`).

## Public surface

- `pub fn router` — function

## Drift-prone areas

- **`require_platform_admin_mw`** (CAS_274EDF3B → NEUTERED by CAS_C8A9) — the
  `/monitoring`, `/metrics`, `/admin` nests each still apply this `from_fn_with_state`
  layer (cloned state: `mon_admin_state` / `metrics_admin_state` / `admin_gate_state`),
  but in the lean single-user build the middleware **admits unconditionally** — no
  `resolve_user_rid` / `is_platform_admin` lookup, zero per-request RBAC SQL. The
  layers are kept so the gate can be re-armed in one place if multi-user returns.
- **`list_viewer`** — the shared reach-filter for list endpoints. NEUTERED: always
  returns `None` (no filter; the sole user sees everything). The multi-tenant
  `Some(principals)` branch was removed with `rbac::principals`.
- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- The static `ServeDir` fallback carries `cache-control: no-cache` under `#[cfg(debug_assertions)]` so dev frontend edits revalidate on a normal reload ([runbook 0009](../../../../runbooks/CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md)). The layer wraps the *service*, not the router, to keep `/api/*` uncached — don't move it onto the outer router.

## Related

- [Backend pillar landing](../../index.md)
