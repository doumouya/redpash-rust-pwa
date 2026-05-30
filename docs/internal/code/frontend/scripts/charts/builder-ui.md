---
title: frontend/scripts/charts/builder-ui.js
source: ../../../../../frontend/scripts/charts/builder-ui.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-05-30
---

# builder-ui.js

## Purpose

Chart-spec authoring accordion. Slice C of the chart-pipeline unification. Lifts the right-side accordion (Chart type / Data / Axes / Legend / Tooltip / Style) out of designer.js so the Settings Monitoring chart picker can mount the same UI.

## Public surface

- mountBuilder(el, ctx) — paints the 6-section accordion.
- Each section: tight form with the cfg-vocabulary inputs.

## Drift-prone areas

- Cfg vocabulary contract with build.js; new chart-kind features need cfg + UI on both sides.

## Related

- [Frontend pillar landing](../../../index.md)
