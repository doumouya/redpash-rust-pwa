---
title: backend/crates/shared/src/search.rs
source: ../../../../../backend/crates/shared/src/search.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# search.rs

## Purpose

Omnisearch DTOs — wire shape for `GET /api/search`.

One flat list of results, `kind`-discriminated. Frontend groups by
`kind` for display and uses the per-result `hash` to navigate
without baking routing rules into the JS — backend names the
destination, frontend just goes there.

## Public surface

- `pub struct SearchResult` — struct
- `pub struct SearchResponse` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
