---
title: backend/crates/shared/src/lib.rs
source: ../../../../../backend/crates/shared/src/lib.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-31
---

# lib.rs

## Purpose

# `shared` — DTOs across the wire

Every struct in this crate is serialised over HTTP and deserialised
on the JS side. Keeping it isolated means the `api` and `data` crates
both depend on a single, dependency-light crate for request /
response shapes — no risk of drift, fast compile.

## Public surface

- `pub struct Page` — struct
- `pub struct Envelope` — struct
- `pub struct ApiError` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- The module set IS the wire surface — adding a `pub mod` here is a public-API change. 2026-05-31: `team` module added next to `company` for the teams CRUD slice.

## Related

- [Backend pillar landing](../index.md)
