---
title: backend/crates/shared/src/step.rs
source: ../../../../../backend/crates/shared/src/step.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# step.rs

## Purpose

ProjectStep — one cleaning operation applied to a file.

Wire shape mirrors the `project_steps` table:
• `ordinal`  is the position in the file's step history.
• `applied`  flips false on undo, true on redo.
• `kind`     is a string (so new step kinds can ship without
touching the DTO); the data crate pattern-matches on
known values and rejects the rest.

## Public surface

- `pub struct ProjectStep` — struct
- `pub struct StepRequest` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
