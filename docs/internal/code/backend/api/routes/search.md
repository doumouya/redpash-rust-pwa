---
title: backend/crates/api/src/routes/search.rs
source: ../../../../../../backend/crates/api/src/routes/search.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-03
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
- **All 5 branches are see-down scoped** (CAS_AF2690C0, step-3): projects + files were already reach-scoped via an `EXISTS`-membership `WHERE`; the users / companies / memberships branches now take the resolved caller as `$3` (`viewer`) and scope the same way — users to company-mates, companies to the caller's companies, memberships to objects the caller is in. Platform admins pass `None` (no scope → full directory). Closes the user/company enumeration + email existence-oracle + membership-graph leak.

## Related

- [Backend pillar landing](../../index.md)
