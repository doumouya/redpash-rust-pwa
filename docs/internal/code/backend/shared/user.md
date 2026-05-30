---
title: backend/crates/shared/src/user.rs
source: ../../../../../backend/crates/shared/src/user.rs
owner: Gus
section: Internal · Code · backend · shared
last modified date: 2026-05-30
---

# user.rs

## Purpose

User + profile + preferences.

Mirrors `core.UserProfile` from the Django side. The `prefs` JSON
blob holds everything that doesn't deserve a column (theme, accent
hue, default rows-per-page, …) — keep it small but free-form.

## Public surface

- `pub struct UserProfile` — struct
- `pub struct UserMembership` — struct
- `pub struct PrefsPatch` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
