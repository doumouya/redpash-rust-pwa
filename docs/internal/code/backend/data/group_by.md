---
title: backend/crates/data/src/group_by.rs
source: ../../../../../backend/crates/data/src/group_by.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# group_by.rs

## Purpose

Group-by + aggregation engine for the Reports page.

`execute(df, spec)` applies the optional pre-filter, groups by the
requested columns, runs each aggregation as a Polars Expr, and
returns the resulting DataFrame. The api crate stringifies the rows
for transport (same shape as the redtable page response).

## Public surface

- `pub fn execute` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
