---
title: frontend/scripts/page-row.js
source: ../../../../frontend/scripts/page-row.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# page-row.js

## Purpose

`.rp-page__row` template helpers. Settings + Profile are largely a stack of rp-page__row instances with the same label/control skeleton. The audit flagged page__row as the highest-saved candidate (~48 LOC across 11 occurrences); the pages now declare rows as data + ship one render call.

## Public surface

- prefRow(spec), valueRow(spec), actionsRow(spec), mountRow(el, spec).
- Spec -> HTML; one render path for every row variant.

## Drift-prone areas

- Spec contract used by Settings + Profile; new row kinds need a *Row helper here.

## Related

- [Frontend pillar landing](../../index.md)
