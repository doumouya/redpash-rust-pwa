---
title: frontend/scripts/charts/build.js
source: ../../../../../frontend/scripts/charts/build.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-05-30
---

# build.js

## Purpose

Chart-spec -> ECharts option translator. Slice A of the chart-pipeline unification (Em 2026-05-27): lift the buildOption + THEMES + TYPES vocabulary out of designer.js so it can be reused by Designer + list-page KPI charts + Settings chart picker.

## Public surface

- buildOption(cfg, theme) — designer cfg vocabulary -> ECharts option.
- THEMES (14 themes), TYPES, TYPE_TO_KIND, TYPE_LIST, SMOOTHABLE.

## Drift-prone areas

- Single source of truth for chart shape; both Designer and renderChart depend on this.

## Related

- [Frontend pillar landing](../../../index.md)
