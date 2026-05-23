---
title: Filter DTO
section: Internal
order: 32
last modified date: 2026-05-24
owner: Gus
status: stub
---

# Filter DTO

> **TODO (Gus).** Spec lock for `shared::filter::{FilterNode, FilterSpec, FilterOp}`. The frontend half is captured at `frontend/scripts/pages/workspace.js` (the OP_TO_WIRE map + `buildFilterNode`).

To cover:

- The canonical 17-variant `FilterOp` enum (after the 3d29291 reconciliation): `Eq, Neq, In, NotIn, Contains, NotContains, StartsWith, EndsWith, Gt, Gte, Lt, Lte, Between, Before, After, IsNull, NotNull`
- Two accepted wire shapes: legacy `Vec<FilterSpec>` (implicit AND) + recursive `FilterNode` (Group/Leaf tree)
- `case_sensitive: Option<bool>` — `None` defaults to true (steps engine) or false (query-time parse) — see commit 5908689
- Where it's consumed: `PageQuery.filters` (workspace), `steps::filter_rows` (persisted), wasm `apply_filter` (browser)
- Adding a new op — both engine paths must implement
