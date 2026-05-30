---
title: frontend/scripts/charts/render.js
source: ../../../../../frontend/scripts/charts/render.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-05-30
---

# render.js

## Purpose

Chart spec -> live ECharts instance. Slice B of the chart-pipeline unification. Sits on buildOption (Slice A) and adds dynamic-data support: a source discriminant + resolver that fetches, normalises, and injects data into the cfg before buildOption runs.

## Public surface

- renderChart(el, spec, theme) — fetch + inject + mount.
- resolveData(source) — per-source fetcher (baked / monitoring-stats / transform).
- applyTransform, readPointer, synthesizeOption.

## Drift-prone areas

- Source discriminant values must match home-bank + monitoring-bank spec shapes.

## Related

- [Frontend pillar landing](../../../index.md)
