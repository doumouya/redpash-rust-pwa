---
title: backend/crates/api/src/routes/files/stats.rs
source: ../../../../../../../backend/crates/api/src/routes/files/stats.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# stats.rs

## Purpose

Stats endpoints for a single file: dedup detection, distinct-value
probe for the filter-panel autocomplete, sentinel scan for the
fix-invalid modal.

All three are read-only queries over the hydrated frame. Split out
of `files/mod.rs` so the per-handler request/response types live
next to their handler instead of cluttering the dispatcher.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
