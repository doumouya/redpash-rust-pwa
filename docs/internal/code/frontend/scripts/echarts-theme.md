---
title: frontend/scripts/echarts-theme.js
source: ../../../../frontend/scripts/echarts-theme.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# echarts-theme.js

## Purpose

ECharts theme registration + resolver — one source of truth for our two RedPash themes (Mocha + Latte). ensureRegisteredThemes() fetches both /echarts-themes/redpash-{mocha,latte}.json once per page load and registers via echarts.registerTheme.

## Public surface

- ensureRegisteredThemes() — memoised promise; safe to await from every chart-init path.
- Theme JSON files live at /echarts-themes/ (served by the api crate).

## Drift-prone areas

- Theme JSON paths are absolute; relocation breaks chart init silently (chart paints in default theme).

## Related

- [Frontend pillar landing](../../index.md)
