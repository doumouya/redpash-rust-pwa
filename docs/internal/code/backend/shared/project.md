---
title: backend/crates/shared/src/project.rs
source: ../../../../../backend/crates/shared/src/project.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# project.rs

## Purpose

Project resource DTOs.

## Public surface

- `pub struct ProjectSummary` — struct
- `pub struct ProjectDetail` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
