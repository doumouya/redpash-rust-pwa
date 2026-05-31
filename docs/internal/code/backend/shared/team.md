---
title: backend/crates/shared/src/team.rs
source: ../../../../../backend/crates/shared/src/team.rs
owner: Torv
section: Internal · Code · backend · shared
last modified date: 2026-05-31
---

# team.rs

## Purpose

Team resource DTOs. Teams are company-scoped subgroups
(`teams.company_id` is NOT NULL, CASCADEs on company delete) and
double as grant-bearing principals in the RBAC resolver
(`rbac::caller_principals`).

## Public surface

- `Team` — bare record: redpash_id, company_id, name, created_at.
- `TeamSummary` — Team flattened + member_count + caller's my_role +
  joined company_name for display.

## Drift-prone areas

- Schema doesn't carry `updated_at` (omitted in migration
  `20260529000000_init.sql`). Adding it = schema migration first,
  then surface here.
- No `slug` or `avatar_url` — keep parity with the team table until
  there's a real UI surface that needs them.
- Per-team members reuse `shared::company::CompanyMember` — the JOIN
  is object-agnostic (keys on `memberships.object_redpash_id`), so a
  parallel `TeamMember` type would only duplicate.

## Related

- [Backend shared landing](index.md)
- [entity-membership-model](../../../../specs/rbac/entity-membership-model.md)
