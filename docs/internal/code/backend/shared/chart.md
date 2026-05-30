---
title: backend/crates/shared/src/chart.rs
source: ../../../../../backend/crates/shared/src/chart.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# chart.rs

## Purpose

Chart resource DTOs.

A saved chart is a self-contained visualisation authored on the
Reports page. It is persisted as a chart-typed `project_files` row;
`spec` carries the whole chart definition as an opaque JSON blob
(kind, group-by / aggregation, the baked-in ECharts `option`, and an
SVG snapshot) — the backend stores and serves it without ever
reading into it.

## Public surface

- `pub struct Chart` — struct
- `pub struct ChartRequest` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
