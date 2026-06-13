---
title: backend/crates/api/src/routes/cases.rs
source: ../../../../../../backend/crates/api/src/routes/cases.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-13
---

# cases.rs

## Purpose

`/api/cases/*` — **LEAN trim** (CAS_C8A9). The only surviving surface is the
category taxonomy the Monitoring page's CATALOG tab reads:

```
GET /api/cases/categories   flat category list (monitoring.js:1270, tabs.js:62)
```

The case + comment CRUD (`list`/`create`/`get_one`/`patch`/`delete_one`,
`list_comments`/`post_comment`/`patch_comment`/`delete_comment`) and the
`/:rid/members` case-team nest were dropped in the single-user slim
(CHECKPOINT-1 approved) — no lean page fetches them. Their full multi-tenant
form lives in the `full-app-pre-slim` tag / `prerelease` branch. The
orphaned `db::list_cases` / `*_case` / `*_comment` helpers were removed with the
handlers (AC-10).

## Public surface

- `pub fn routes` — a single `GET /categories` route → `list_categories`, which
  returns the global seeded taxonomy (`db::list_categories`). The FE groups by
  `parent_id` to build the picker tree.

## Drift-prone areas

- Wire shapes in `shared::case::Category` change in lockstep with this file; backend ↔ frontend ↔ DB seam.
- **No RBAC gate** — the lean build is single-user; `list_categories` just resolves the caller and returns the global taxonomy. See [rbac.rs](../rbac.md) for the neutered gate surface.

## Related

- [Backend pillar landing](../../index.md)
