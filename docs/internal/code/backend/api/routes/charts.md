---
title: backend/crates/api/src/routes/charts.rs
source: ../../../../../../backend/crates/api/src/routes/charts.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# charts.rs

## Purpose

`/api/charts/*` — CRUD for saved charts.

A saved chart is a self-contained visualisation authored on the
Reports page, persisted as a chart-typed `project_files` row. The
backend stores the chart's JSON `spec` (ECharts option + SVG snapshot
+ group / aggregation) opaquely — it never runs queries on a chart.

## Public surface

- `pub fn routes` — function

## Gates

- `get_one` — `chart.view` (cascade chart→project→company; any effective role).
- `update_one` / `delete_one` — `require_grant`, `effective() >= Admin`. A chart
  is a `project_files` row with no direct membership, so the owner resolves to
  `scope` `Owner` via the project; project/company admins reach it via cascade;
  platform bypasses. Members/viewers can view but not mutate.
- `create` — stays gated on viewing the **source file** (the data dependency),
  not on the chart row (which doesn't exist yet).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
