---
title: backend/crates/shared/src/company.rs
source: ../../../../../backend/crates/shared/src/company.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# company.rs

## Purpose

Company resource DTOs.

A company is the multi-tenancy boundary: a user belongs to zero or
more companies via the unified `memberships` table. Projects can be
scoped to a company or stay personal (`company_id = NULL`).

## Public surface

- `pub struct Company` — struct
- `pub struct CompanySummary` — struct
- `pub struct CompanyMember` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
