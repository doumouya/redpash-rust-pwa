---
title: backend/crates/api/src/rbac.rs
source: ../../../../../backend/crates/api/src/rbac.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-05-31
---

# rbac.rs

## Purpose

The RBAC **effective-access resolver** — the
[entity-membership-model](../../../specs/rbac/entity-membership-model.md) §2
query in code. **Enforced 2026-05-31**: `require_grant` / `require_view` gate
reads + mutations across every object type (companies, projects, cases,
files/charts/dashboards, comments) and the generic member-CRUD module; the
mutation gates were broadened off `ensure_owner` onto this resolver. Workstream
of record: case CAS_913220A003484841BF98250DD0FEF681.

`effective_role(pool, caller, object)` returns the **highest** permission tier
(`Role`, ordered `Viewer < Member < Admin < Owner`) the caller holds on the
object, unioned across three sources, or `None` (default-deny):

1. **direct** — a membership edge on the object itself
2. **cascade** — a membership on the object's scope (its company / project; for
   `project_files` the chain file → project → company)
3. **team** — a membership held by any team the caller belongs to (recursive
   CTE, so nested teams close)

## Public surface

- `pub enum Role` — `Viewer · Member · Admin · Owner`, `Ord` so "highest role
  wins" is a `max`.
- `pub struct Grant { direct, scope }` — access split by **reach**: `direct` =
  tier from a membership ON the object (own); `scope` = tier via the
  company/project cascade. Accessors: `effective()` (max of both),
  `is_member()` (own?), `scope_at_least(Role)`.
- `pub async fn resolve_grant` — the reach-aware resolver (one query, two
  reach columns). The keystone.
- `pub async fn effective_role` — `resolve_grant(...).effective()` (thin view).
- `pub async fn principals` — the caller's principal set (self + teams,
  recursive); resolve once, then a list query scopes rows with
  `member_redpash_id = ANY($principals)` instead of per-row recursion (P4
  list-scoping uses this).
- `pub async fn is_platform_admin` — full-access check (the catalog's
  `*.view.all`): the bootstrap `dev_user` (fast-path, no query) **or** any
  `users.role = 'admin'` (mig 20260531000002 — retires the old dev_user-only
  stopgap). Platform admins bypass every gate.
- `pub async fn require_grant(…, rule)` — generic gate: `is_platform_admin`
  bypasses; else the closure decides on the resolved `Grant`; else 404
  (leak-free). Handlers express each atom's rule, e.g. `case.update` →
  `|g| g.is_member() || g.scope_at_least(Role::Admin)`.
- `pub async fn require_view` — `require_grant` with `|g| g.effective().is_some()`.
- `pub fn Role::as_str` — lowercase wire label (`owner`/`admin`/`member`/`viewer`),
  matches the `memberships.role` CHECK; used to serialize a tier for introspection.
- `pub struct GrantEdge { object, member, role, context_role, reach }` +
  `pub async fn grant_edges` — admin **introspection** (CAS_274EDF3B): the
  membership edges across the subject's principal closure that grant any reach
  on an object — the "why" behind a `Grant`. `reach` = `direct` (on the object)
  or `scope` (on a parent). Backs `GET /api/admin/rbac` (platform-admin gated in
  [routes/admin.rs](routes/admin.md)). Read-only; pairs with `resolve_grant`
  (tiers) for "who has reach on X, and why".

## Drift-prone areas

- The `scopes` CTE encodes object→scope containment per object type. When a new
  scoped object type lands (or a containment FK changes), extend the CTE's
  `UNION` arms or the resolver silently under-reaches.
- **`EDGES_SQL` (introspection) duplicates GRANT_SQL's principal-closure +
  cascade-scope CTEs** — keep them in sync. Where `GRANT_SQL` collapses to
  max-rank-per-reach, `EDGES_SQL` returns the underlying rows; a containment
  change must be made in both.
- Mirrors the SQL validated in
  [entity-membership-model §2](../../../specs/rbac/entity-membership-model.md);
  keep the `role` rank mapping (`owner=4 … viewer=1`) in sync with the
  `memberships.role` CHECK.

## Related

- [entity-membership-model](../../../specs/rbac/entity-membership-model.md) — the §2 resolver spec.
- [rbac catalog index](../../../specs/rbac/index.md) — the policy layer that will read this.
- [Backend pillar landing](../index.md)
