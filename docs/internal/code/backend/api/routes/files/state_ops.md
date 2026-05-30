---
title: backend/crates/api/src/routes/files/state_ops.rs
source: ../../../../../../../backend/crates/api/src/routes/files/state_ops.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# state_ops.rs

## Purpose

Cleaner-sidebar state operations: cast dry-run (preview lost
rows), undo / redo (walk the step history), clear_filters (eraser
that surgically un-applies every filter_rows step regardless of
position in history).

All four are pure state-machine ops on `project_steps` + the cached
frame eviction. None mutate the canonical CSV bytes on disk and none
query data — they're the "what step is applied" toggles.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
