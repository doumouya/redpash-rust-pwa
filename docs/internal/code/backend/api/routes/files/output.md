---
title: backend/crates/api/src/routes/files/output.rs
source: ../../../../../../../backend/crates/api/src/routes/files/output.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# output.rs

## Purpose

File-materialisation endpoints: snapshot (post-replay → new project
file on disk) and export (post-replay → download stream).

Both surface the current view (after step replay) as bytes. Snapshot
persists a new project_files row; export is one-shot and stateless.
Co-located here because they share the data::dtype / data::stats /
data::export call surface and the spawn_blocking + CSV-writer
pattern.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
