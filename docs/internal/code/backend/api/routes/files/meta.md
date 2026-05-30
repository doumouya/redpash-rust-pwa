---
title: backend/crates/api/src/routes/files/meta.rs
source: ../../../../../../../backend/crates/api/src/routes/files/meta.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-30
---

# meta.rs

## Purpose

File-metadata mutation endpoints: set_encoding (override the
chardetng guess; evicts the cache so the next hydrate re-decodes
with the user's choice) and the cleanness compute / clear pair
(re-score against the user's full sentinel vocabulary; null-out the
stored score for dev/test).

Grouped here because all three are metadata-only writes — they
don't materialise new bytes (that's `output.rs`) and don't query
data (that's `stats.rs`). They flip a column on `project_files` +
evict the cached frame.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
