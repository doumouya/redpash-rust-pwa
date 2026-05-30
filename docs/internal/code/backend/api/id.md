---
title: backend/crates/api/src/id.rs
source: ../../../../../backend/crates/api/src/id.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# id.rs

## Purpose

RedPash-ID generation.

Format: `<PREFIX>_<32-char-uppercase-hex>` — e.g.
`FIL_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2`. 36 chars total. URL-safe,
easy to spot in logs.

## Public surface

- `pub fn new` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
