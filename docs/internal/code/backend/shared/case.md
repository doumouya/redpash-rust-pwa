---
title: backend/crates/shared/src/case.rs
source: ../../../../../backend/crates/shared/src/case.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# case.rs

## Purpose

Case + Comment DTOs — the Jira-flow workstream's wire shapes.

Case lifecycle changes are NOT modelled as a parallel struct here;
they live as `events.kind = 'case_*'` rows persisted through the
existing `event::record` path (cat-3 audit-trail discipline). The
case detail page's Activity tab consumes `Event` records filtered
by `context->>'case'`, not a separate History DTO.

## Public surface

- `pub struct Category` — struct
- `pub struct Case` — struct
- `pub struct Comment` — struct
- `pub struct CaseDetail` — struct
- `pub struct CaseCreateRequest` — struct
- `pub struct CasePatchRequest` — struct
- `pub struct CommentRequest` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
