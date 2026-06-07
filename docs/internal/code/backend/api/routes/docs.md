---
title: backend/crates/api/src/routes/docs.rs
source: ../../../../../../backend/crates/api/src/routes/docs.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# docs.rs

## Purpose

`/api/docs` — serves the `docs/internal/` markdown tree (`DOCS_DIR =
"../docs/internal"`) as a browsable index plus rendered HTML. Authed (no DB).
Repointed from the old `../docs` to internal-only in the docs rebuild
(CAS_701CF65E) — the public tier was folded into one internal tree.

GET /api/docs          → { items: [{ slug, title, section, order,
last_modified }, …] }
GET /api/docs/<slug>   → rendered HTML for one page

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
