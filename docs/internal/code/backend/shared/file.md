---
title: backend/crates/shared/src/file.rs
source: ../../../../../backend/crates/shared/src/file.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# file.rs

## Purpose

File (project_files row) DTOs.

## Public surface

- `pub struct FileSummary` — struct
- `pub struct ColumnMeta` — struct
- `pub struct PageQuery` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
