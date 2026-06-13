---
title: backend/crates/api/src/state.rs
source: ../../../../../backend/crates/api/src/state.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-06-14
---

# state.rs

## Purpose

Shared application state.

Cloned into every handler via Axum's `State<AppState>` extractor —
everything inside is `Arc`-backed and cheap to clone.

## Public surface

- `pub struct FileEntry` — struct
- `pub struct OAuthConfig` — struct
- `pub struct AppState` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
