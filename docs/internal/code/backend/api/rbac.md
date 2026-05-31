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
query in code. P1 of the enforcement workstream (the resolver only; no gate
wires it in yet).

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
- `pub async fn effective_role` — the resolver.

## Drift-prone areas

- The `scopes` CTE encodes object→scope containment per object type. When a new
  scoped object type lands (or a containment FK changes), extend the CTE's
  `UNION` arms or the resolver silently under-reaches.
- Mirrors the SQL validated in
  [entity-membership-model §2](../../../specs/rbac/entity-membership-model.md);
  keep the `role` rank mapping (`owner=4 … viewer=1`) in sync with the
  `memberships.role` CHECK.

## Related

- [entity-membership-model](../../../specs/rbac/entity-membership-model.md) — the §2 resolver spec.
- [rbac catalog index](../../../specs/rbac/index.md) — the policy layer that will read this.
- [Backend pillar landing](../index.md)
