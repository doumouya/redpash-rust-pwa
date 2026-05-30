---
title: backend/crates/api/src/db/entities.rs
source: ../../../../../../backend/crates/api/src/db/entities.rs
owner: Gus
section: Internal · Code · backend · api · db
last modified date: 2026-05-30
---

# entities.rs

## Purpose

Entity Registry (supertype) helpers — step 1a of the membership
consolidation (case CAS_DC7EDAF82F1E494F846D83FA71C411A2).

`entities` is the universal object handle: every top-level entity's
`redpash_id` FKs into it `ON DELETE CASCADE`, so polymorphic relations
(memberships) inherit DB-enforced cascade with no triggers. Today the
registry covers the membership OBJECT types (company / project / case);
user/file join later when something points polymorphically at them.

## Public surface

- `pub fn register_entity` — function
- `pub fn delete_entity` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
