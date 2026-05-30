---
title: frontend/scripts/joins.js
source: ../../../../frontend/scripts/joins.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# joins.js

## Purpose

Sibling-file join picker for the workspace Tools panel (Joins tab). Backend contract: GET /api/files/:rid/joins returns candidates; POST /api/files/:rid/joins applies. Mounted eagerly so candidates preload on file-open (2026-05-29).

## Public surface

- mountJoins(panelBody, ctx) returns { refresh, applyJoin }.
- Per-card UI: pickable candidate rows + Apply button.
- POST response = new file envelope; consumer refreshAndOpens the join result.

## Drift-prone areas

- Eager-mount means /joins fires per file-open; intentional on localhost (see feedback-redpash-stage).

## Related

- [Frontend pillar landing](../../index.md)
