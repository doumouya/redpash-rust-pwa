---
title: frontend/scripts/designer.js
source: ../../../../frontend/scripts/designer.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-07
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
- **Class family is `rp-dash-*`** (migrated from the legacy `ds-*` on 2026-06-07; the dedup `c282646` had renamed the CSS in `dashboards.css` but left this emitter on `ds-*`, so the `.ds-chart` ECharts mount got no height → empty preview). The empty-state uses the shared `.rp-empty` atom. Emitting a retired `ds-*` name again **fails `tools/retired-class-audit`** (runbook 0017).
- **The same dedup also renamed BARE classes this file emits** (caught by the adversarial review, not the prefix-guard): tile grid spans `span-N → rp-dash-span-N` (else a tile gets no `grid-column` and collapses), and the tile selection state `selected → is-selected` (`.rp-dash-tile.is-selected`). Both are migrated here. These bare/state renames aren't prefix-guardable — verify them by review when touching tile markup.

## Related

- [Frontend pillar landing](../../index.md)
