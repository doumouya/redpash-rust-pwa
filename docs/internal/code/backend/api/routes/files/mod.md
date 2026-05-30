---
title: backend/crates/api/src/routes/files/mod.rs
source: ../../../../../../../backend/crates/api/src/routes/files/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# mod.rs

## Purpose

`/api/files/*` — upload, summary, paged rows, steps.

Persistence model:
• Bytes      → `<data_dir>/files/<rid>.bin` (immutable).
• Metadata   → `project_files` row.
• History    → `project_steps` rows (append-only, `applied` toggled
by undo/redo, redo stack cleared on new step).
• Hot frame  → in-memory cache; cache miss replays all applied
steps on top of the freshly-parsed base.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
