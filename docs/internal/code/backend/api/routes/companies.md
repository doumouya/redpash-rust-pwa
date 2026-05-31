---
title: backend/crates/api/src/routes/companies.rs
source: ../../../../../../backend/crates/api/src/routes/companies.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
---

# companies.rs

## Purpose

`/api/companies` — companies + memberships.

A company is the multi-tenancy boundary: a user belongs to zero or
more companies via the unified `memberships` table. That table also IS
the access-control check — every handler resolves the caller's role and
404s (not 403) when they aren't a member, so company existence is
never leaked.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
