---
title: DB RBAC — internal
section: Internal
last modified date: 2026-06-07
---

# RBAC

The access-control model: who can do what, to which entity. The polymorphic
entity ↔ membership edge is the spine of the whole authorization system.

> Migrating in (CAS_701CF65E) from `specs/rbac/*` — the high-value keepers.
> Per-object RBAC rows merge into the matching [db/schemas/](../schemas/index.md)
> doc; the model-level docs live here. Phase C.

## Docs

- [entity.md](entity.md) — the entity ↔ membership model (from `specs/rbac/entity-membership-model.md`).
- [memberships.md](memberships.md) — the polymorphic membership edge (from `specs/rbac/membership.md`).
- [teams.md](teams.md) — team membership (from `specs/rbac/team.md`).
- [permission-contract.md](permission-contract.md) — the role × action contract (from `specs/rbac/permission-contract.md`).

## The role spine

owner > admin > member > viewer (4-tier). The gates + cross-tenant isolation
rules port here from the RBAC epics.

## Source files

- [`code/backend/api/`](../../code/index.md) — `field_perms`, the membership
  query layer, the route guards (the survival-layer deep dives).
