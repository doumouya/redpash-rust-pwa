---
title: frontend/scripts/charts/home-bank.js
source: ../../../../../frontend/scripts/charts/home-bank.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-05-30
---

# home-bank.js

## Purpose

Schema + default chart specs per Home tab. Slice D2 of the chart-pipeline unification. Mirror of monitoring-bank.js for the Home page LIST_VIEWS tabs. Same monitoring-stats source kind.

## Public surface

- HOME_STATS_SCHEMA — per-tab endpoint + field paths.
- HOME_DEFAULT_CHARTS — per-tab default chart bank.
- chartsForTab(tabKey, userPref), newChartTemplate(tabKey).

## Drift-prone areas

- Stats endpoint contract: pointer shapes must match what the per-tab stats endpoint returns.

## Related

- [Frontend pillar landing](../../../index.md)
