---
title: backend/crates/api/src/routes/cases.rs
source: ../../../../../../backend/crates/api/src/routes/cases.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
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

## Related

- [Backend pillar landing](../../index.md)
