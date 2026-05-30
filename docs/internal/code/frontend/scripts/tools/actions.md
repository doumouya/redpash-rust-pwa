---
title: frontend/scripts/tools/actions.js
source: ../../../../../frontend/scripts/tools/actions.js
owner: Torv
section: Internal · Code · Frontend · scripts/tools
last modified date: 2026-05-30
---

# actions.js

## Purpose

Tools-panel toolbar actions — slice 2 of the tools.js decomposition. Two action lists used by the columns-view toolbar.

## Public surface

- GLOBAL_ACTIONS — 4 entries (snake_case_columns, replace_in_names, change_case, unwrap_csv).
- SELECT_ACTIONS — 9 entries (drop / keep / drop_nulls / fill_nulls / replace / fix_invalid / join / split / format_dates).
- Each entry: { kind, min, max?, label, icon, hasSheet?, ... }.

## Drift-prone areas

- kind strings must match data::steps::apply() arms.

## Related

- [Frontend pillar landing](../../../index.md)
