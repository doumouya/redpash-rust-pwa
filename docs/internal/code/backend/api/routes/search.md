---
title: backend/crates/api/src/routes/search.rs
source: ../../../../../../backend/crates/api/src/routes/search.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# search.rs

## Purpose

`/api/search` — omnisearch backing the topbar input.

GET /api/search?q=<text>&limit=<int>

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
