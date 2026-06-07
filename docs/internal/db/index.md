---
title: DB — internal
section: Internal
last modified date: 2026-06-07
---

# DB

The data model: every object's schema + the RBAC model that governs access.

> Migrating in (CAS_701CF65E): replaces the old `specs/object-metadata/*`,
> public `docs/db/*`, and `docs/objects/*`. Schemas become **generated**; the
> RBAC + per-field business-logic prose is hand-written.

## Sub-areas

- [schemas/](schemas/index.md) — one doc per object: a **generated** schema
  table (from the live DB) + hand-written field/business-logic prose.
- [rbac/](rbac/index.md) — the entity ↔ membership model: entity, memberships,
  teams, and the permission contract.

## Full-schema overview (generated)

<!-- doc-gen:schema:overview START -->
_(generated — run `node tools/doc-gen/gen.js --schema`)_
<!-- doc-gen:schema:overview END -->

## Conventions

- **RedPash-ID** — every row carries a typed `redpash_id` (`USR_`, `PRJ_`,
  `FIL_`, `CAS_`, `CHT_`, …); see [`stack/db`](../stack/index.md).
- **Migrations** — `backend/crates/api/migrations/`.

## Source files

- [`code/backend/api/db/`](../code/index.md) — the query layer (the deep dives).
- [`code/backend/shared/`](../code/index.md) — the DTOs.
