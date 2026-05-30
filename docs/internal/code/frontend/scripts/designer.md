---
title: frontend/scripts/designer.js
source: ../../../../frontend/scripts/designer.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# designer.js

## Purpose

Chart/dashboard authoring surface. Ported from the red-front prototype. Same shape: canvas (12-col grid of tiles) + right-side accordion (Chart type / Data / Axes / Legend / Tooltip / Style) + 3 chart themes.

## Public surface

- mountDesigner(el, ctx) — mounts the full designer canvas + accordion.
- load(chart) — opens an existing chart spec; null to clear.
- Composes charts/build.js + charts/render.js + charts/builder-ui.js.

## Drift-prone areas

- Chart spec wire (shared::chart::ChartSpec) — drift between Rust and the form-renderer breaks load/save.

## Related

- [Frontend pillar landing](../../index.md)
