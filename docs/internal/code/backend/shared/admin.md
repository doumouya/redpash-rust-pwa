---
title: backend/crates/shared/src/admin.rs
source: ../../../../../backend/crates/shared/src/admin.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-31
---

# admin.rs

## Purpose

Admin summaries — slim wire shapes for the `/api/admin/*` list
endpoints powering Home's org/data rail tabs.

Each `*Summary` is a list-projection: enough fields for the
redtable + KPI strip on the Home tab, with the heavier per-entity
detail (prefs JSONB, full ColumnMeta vec, step params, etc.) left
to the existing resource endpoints. The frontend renders Home as
a read-only browser; per-row drill-down opens the entity's normal
detail page.

## Public surface

- `pub struct UserSummary` — struct
- `pub struct MembershipSummary` — struct
- `pub struct AdminFileSummary` — struct
- `pub struct ChartSummary` — struct
- `pub struct StepSummary` — struct
- `pub struct UserStats` — struct
- `pub struct CompanyStats` — struct
- `pub struct TeamStats` — struct (Teams tab KPI: total / with_members / by_company)
- `pub struct MembershipStats` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
