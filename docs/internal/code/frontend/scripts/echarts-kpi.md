---
title: frontend/scripts/echarts-kpi.js
source: ../../../../frontend/scripts/echarts-kpi.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# echarts-kpi.js

## Purpose

Small chart wrappers for KPI cards across Home, Monitoring, Profile. Each function takes a DOM element + the data shape that surface naturally has + an opts bag, inits ECharts against the chrome-matching theme, returns the instance.

## Public surface

- kpiLine(el, points, opts), kpiBar(el, data, opts), kpiDonut(el, data, opts), etc. (per-kind functions).
- Each returns the ECharts instance — caller manages dispose/resize.

## Drift-prone areas

- ECharts option shapes differ from the Designer buildOption vocabulary; this is the compact-tile path. Do not merge without a compact flag.

## Related

- [Frontend pillar landing](../../index.md)
