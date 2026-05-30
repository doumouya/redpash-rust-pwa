---
title: frontend/scripts/report/vocab.js
source: ../../../../../frontend/scripts/report/vocab.js
owner: Torv
section: Internal · Code · Frontend · scripts/report
last modified date: 2026-05-30
---

# vocab.js

## Purpose

Report builder vocabulary — slice 7 of the god-object decomposition. Pure data, module-private, structural-only.

## Public surface

- AGG_FNS — 11 [value, label] pairs for aggregation functions.
- WINDOW_KINDS, WINDOW_RANGES, SORT_DIRS, TOP_N_PRESETS.

## Drift-prone areas

- Mirrors shared::report::ReportSpec enum variants; backend drift = UI shows stale options.

## Related

- [Frontend pillar landing](../../../index.md)
