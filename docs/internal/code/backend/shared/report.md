---
title: backend/crates/shared/src/report.rs
source: ../../../../../backend/crates/shared/src/report.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# report.rs

## Purpose

Grouping / report-spec DTOs.

`ReportSpec` is the grouping shape — what columns to group by, what
aggregations to compute, an optional filter to apply first, and the
`ChartSpec`s authored alongside it. It feeds the stateless
`/api/group/preview` engine and chart files. There is no stored
`Report` entity — the object-model hard-refresh removed it;
"Report" is a derived view over a project's chart files.

## Public surface

- `pub struct ReportSpec` — struct
- `pub struct WindowSpec` — struct
- `pub struct TopNFilter` — struct
- `pub struct ChartSpec` — struct
- `pub struct SortSpec` — struct
- `pub struct Aggregation` — struct
- `pub enum AggFn` — enum

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
