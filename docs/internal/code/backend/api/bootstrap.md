---
title: backend/crates/api/src/bootstrap.rs
source: ../../../../../backend/crates/api/src/bootstrap.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# bootstrap.rs

## Purpose

Startup-time idempotent setup.

Runs after migrations. Ensures the dev user + their default project
exist so the upload pipeline always has somewhere to put files. Once
Phase 4 (Google OAuth) ships, this falls back to a no-op when at
least one human user already exists.

## Public surface

- `pub struct Bootstrap` — struct
- `pub fn run` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
