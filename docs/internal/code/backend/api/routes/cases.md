---
title: backend/crates/api/src/routes/cases.rs
source: ../../../../../../backend/crates/api/src/routes/cases.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# cases.rs

## Purpose

`/api/cases/*` — Jira-flow workstream v1: case + comment CRUD.

Cases are the team's coordination + customer-ticket layer on top
of the audit-everything spine. Case lifecycle changes (status,
priority, assignee, type, project, company) emit `events.kind =
'case_*'` rows via the existing `event::record` path so the
activity feed query (the case detail page's "Activity" tab) is
literally `SELECT * FROM events WHERE context->>'case' = $1`.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **RBAC enforced** (P2/P4) — all gated via the reach-aware `crate::rbac` resolver; `dev_user` bypasses everything (dev-mode admin):
  - `get_one` (detail) + `list`/`count` (scoped via `rbac::principals`) → `case.view` (any reach).
  - `patch` → `case.update`: own (a case membership) **or** company admin+ (`scope_at_least(Admin)`). A bare company member can't general-edit (status-only is a finer atom, deferred).
  - `delete_one` → `case.delete`: company admin+ only, **never @own** (a reporter can't delete their own case).
  - Still ungated: comments + finer field-level atoms (`case.priority` company-only etc.). See [rbac.rs](../rbac.md) + [entity-membership-model §2](../../../../specs/rbac/entity-membership-model.md).

## Related

- [Backend pillar landing](../../index.md)
