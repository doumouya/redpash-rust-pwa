---
title: frontend/scripts/tools.js
source: ../../../../frontend/scripts/tools.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# tools.js

## Purpose

Cleaning tools — the workspace tools panel, parameterised. One factory + N tool configs + a single form renderer composing 5 field-type renderers. Master/detail loop: list -> click -> form -> Apply -> POST /api/files/:rid/steps -> response file envelope -> table re-render without refetch.

## Public surface

- mountTools(panelBody, ctx) — mounts the columns-redtable + cleaning toolbar.
- Composes tools/{catalog, actions, fields}.js.
- Returns { refresh }.

## Drift-prone areas

- Step kind strings must match server data::steps::apply() dispatcher arms verbatim.

## Related

- [Frontend pillar landing](../../index.md)
