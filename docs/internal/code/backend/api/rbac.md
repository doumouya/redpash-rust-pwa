---
title: backend/crates/api/src/rbac.rs
source: ../../../../../backend/crates/api/src/rbac.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-14
---

# rbac.rs

## Purpose

The handler-facing RBAC **gates**. **NEUTERED in the lean single-user build**
(CAS_C8A9A3EC0935498880A468625FE3F490): RedPash slimmed to a personal,
single-user data tool, so the four gate fns + the `/monitoring`-`/metrics`-
`/admin` middleware admit **unconditionally with ZERO per-request RBAC/membership
SQL** — they return `Ok(())`/admit before the pool is ever touched. The
multi-tenant resolver and the per-company permission-contract evaluator were
**deleted** in the slim; the full multi-tenant form is preserved in the
`full-app-pre-slim` tag / `prerelease` branch and can be re-introduced cheaply if
multi-user ever returns.

The gate **signatures are unchanged** so every call site across the route modules
compiles untouched — the `rule` closure / `label` / `Action` args are retained,
they are simply ignored. This is the deliberate "safe floor": deleting the
machinery without rewriting ~40 call sites.

## Public surface

- `pub enum Role` — `Viewer · Member · Admin · Owner`, `Ord`. Retained because the
  call sites still pass `Role`-typed closures (e.g. `|g| g.scope_at_least(
  Role::Admin)`); the neutered gates ignore the closure. `Role::as_str` →
  lowercase wire label, used by `db::company_role` + admin introspection.
- `pub struct Grant { direct, scope }` — the reach-split access type the gate
  closures are written against. Accessors `effective()` / `is_member()` /
  `scope_at_least(Role)` are retained for the closure expressions; in lean mode no
  `Grant` is ever resolved (the gates short-circuit first).
- `pub async fn is_platform_admin` — full-access check: the bootstrap `dev_user`
  (fast-path, no query) **or** `users.role = 'admin'`. Still consulted by the
  remaining list/me surfaces (NOT by the neutered gates). The sole lean user is
  the dev user → always `true`, no query.
- `pub async fn require_grant(…, rule)` — **NEUTERED**: returns `Ok(())`
  unconditionally; the `rule` closure is ignored. Signature unchanged.
- `pub async fn require_view` — **NEUTERED**: returns `Ok(())`.
- `pub async fn require_action(state, caller, object, Action)` — **NEUTERED**:
  returns `Ok(())`; the `Action` arg is retained so call sites compile.
- `pub enum Action { View, Create, Edit, Delete }` — `crud()` (→ r/c/u/d) +
  `min_tier()` retained for `require_action`'s signature. The two methods are now
  unused (their only caller, `evaluate`, was deleted) — covered by the module
  `#[allow(dead_code)]`, kept as restore surface.

**Deleted in the lean slim:** `resolve_grant`, `GRANT_SQL`, `EDGES_SQL`,
`grant_edges` / `GrantEdge`, `principals`, `effective_role` — the multi-tenant
reach resolver, the introspection query, and the principal-closure helper. Their
former callers (`field_perms::require_fields`, `pipeline::upload_csv`,
`routes::list_viewer`, `routes/cases.rs` list filter, `routes/admin.rs::rbac_resolve`)
were collapsed to no-filter / admit-all in the same change.

**Deleted in the AC-7 tail (CAS_C8A9, 2026-06-14):** `Contract` + `impl` +
`load_contract` + the private `company_of` / `evaluate` (the per-company
permission-contract storage/evaluator) and the `#[cfg(test)] contract_tests`
module that was their last referrer. The contract layer is preserved in the
`full-app-pre-slim` snapshot; nothing in the lean build evaluates it.

## Drift-prone areas

- **The gates are no-ops — do NOT add per-request RBAC SQL behind them.** Any
  query in `require_grant` / `require_view` / `require_action` / the
  `require_platform_admin_mw` would re-introduce the multi-tenant cost the lean
  build deliberately removed; the tester's `#[cfg(test)] neuter_tests` (dead-pool
  oracle) goes RED if a gate touches the pool for a non-dev caller.
- The module `#[allow(dead_code)]` on `mod rbac` (`main.rs`) now covers only the
  neuter-orphaned resolver helpers (`Role::from_rank`, the `Grant` reach-methods,
  `Action::crud` / `min_tier`) — the multi-tenant **restore surface**. Don't delete
  these piecemeal; re-arming RBAC restores them as a set.
- Re-arming multi-tenant RBAC = restore from the `full-app-pre-slim` tag; don't
  hand-reconstruct the resolver.

## Related

- [entity-membership-model](../../../specs/rbac/entity-membership-model.md) — the §2 resolver spec.
- [permission-contract](../../../specs/rbac/permission-contract.md) — the versioned-JSONB contract model (two axes, storage, semantics). **Historical for the lean build** — the evaluator was deleted; preserved in `full-app-pre-slim` for a multi-user restore.
- [rbac catalog index](../../../specs/rbac/index.md) — the policy layer that will read this.
- [Backend pillar landing](../index.md)
