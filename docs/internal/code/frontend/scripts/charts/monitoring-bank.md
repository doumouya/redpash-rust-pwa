---
title: frontend/scripts/charts/monitoring-bank.js
source: ../../../../../frontend/scripts/charts/monitoring-bank.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-05-30
---

# monitoring-bank.js

## Purpose

Schema + default chart specs per Monitoring tab. Slice D of the chart-pipeline unification. Per-tab: when user saved charts exist under user_preferences.prefs.monitoringCharts.<tab>, they drive the strip; else fall back to curated kpiX charts.

## Public surface

- MON_STATS_SCHEMA — per-tab endpoint + addressable field paths.
- MON_DEFAULT_CHARTS — per-tab default chart bank.
- chartsForTab, newChartTemplate.

## Drift-prone areas

- Mirror of home-bank.js; same monitoring-stats source kind.

## Related

- [Frontend pillar landing](../../../index.md)
