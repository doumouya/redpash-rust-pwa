---
title: backend/crates/api/src/routes/files/state_ops.rs
source: ../../../../../../../backend/crates/api/src/routes/files/state_ops.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# state_ops.rs

## Purpose

Cleaner-sidebar state operations: `step_preview` (generic dry-run —
diff ANY step before applying), `cast_preview` (cast-only lost-rows
dry-run, the original `step_preview` generalizes), undo / redo (walk
the step history), clear_filters (eraser that surgically un-applies
every filter_rows step regardless of position in history).

All are pure state-machine ops on `project_steps` + the cached frame
eviction. None mutate the canonical CSV bytes on disk. The two preview
handlers persist nothing at all — they run the step on a clone, diff
it, and throw the result away.

## Public surface

- Module-private handlers (`pub(super)`); no top-level `pub` items.
- `step_preview` → `POST /api/files/:rid/steps/preview` `{kind,params}`:
  dry-runs `data::steps::apply` + returns `data::stats::FrameDiff`
  (rows Δ, cells changed/nulled, cols added/removed/renamed, capped
  Before|After sample). Gated like `add_step` (Admin via any reach).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
