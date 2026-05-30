---
title: backend/crates/api/src/routes/mod.rs
source: ../../../../../../backend/crates/api/src/routes/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# mod.rs

## Purpose

Route assembly.

Each resource is its own module (`health`, `files`, …) and exposes a
`pub fn routes() -> Router<AppState>` that gets nested under its URL
prefix here. Keeping the tree assembled in one place makes the API
surface easy to audit.

## Public surface

- `pub fn router` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
