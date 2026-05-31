---
title: backend/crates/api/src/routes/teams.rs
source: ../../../../../../backend/crates/api/src/routes/teams.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31 (kind field)
---

# teams.rs

## Purpose

`/api/teams` — teams CRUD + per-team member CRUD.

A team is a company-scoped subgroup, used as a grant-bearing
principal by the RBAC resolver (`rbac::caller_principals`). The
membership edge is the same polymorphic `memberships` table as
companies/projects/cases — so `routes/members.rs` is mounted under
`/:rid/members` unchanged.

```
GET    /              list teams (broader than membership — like /companies)
POST   /              create team + seat creator as owner (atomic)
GET    /:rid          read (any member)
PATCH  /:rid          update (team admin+ or platform admin) — name only
DELETE /:rid          delete (team owner only or platform admin)
.nest("/:rid/members", super::members::routes())
```

## Public surface

- `pub fn routes` — function (mounts under `/api/teams` in
  [`routes/mod.rs`](mod.md))

## Drift-prone areas

- Create gate: caller must reach the parent company at member+
  (`rbac::require_grant(… company, |g| g.effective().is_some())`) so
  an outsider can't plant a team inside a company they don't belong
  to. Platform-admin bypasses via the resolver.
- **`kind` field on `CreateTeamBody`** — `team` (default) or
  `department`. Validated at the API edge with a 400 (clean error)
  instead of letting the schema CHECK 23514 surface as a 500.
  Departments carry single-direct-dept-per-user + single-parent
  invariants enforced downstream by the
  `enforce_one_department_per_user` trigger + `routes/members.rs`
  add 409. The `entities.type` stays `'team'` for both kinds —
  `kind` is a teams-table discriminator, not an entity type (see
  CAS_913 019cd4a settled-dept context).
- Create binds the FK-violation 23503 to a 404 — bad `company_id` →
  "company not found", not a 500.
- PATCH only edits `name` today; `company_id` is intentionally
  immutable from this endpoint (moving a team across companies
  changes inherited grants — deserves its own audit-eventful path).
- Same shape as [companies.rs](companies.md) — keep the two files in
  step when one grows a new field / gate. The shared bits (manage,
  last-owner, self-leave) live in [members.rs](members.md).

## Related

- [Backend api routes landing](mod.md)
- [shared/team](../../shared/team.md)
- [members](members.md) — the generic edge CRUD this mounts
- [entity-membership-model](../../../../specs/rbac/entity-membership-model.md)
