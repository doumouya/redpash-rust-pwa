---
title: frontend/scripts/rail-controls.js
source: ../../../../frontend/scripts/rail-controls.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# rail-controls.js

## Purpose

Rail interaction helpers — the two rail-control patterns hand-rolled per page (Em 2026-05-29 consolidation batch). CSS atoms (.rt-nav / .rt-seg--rail) were already shared; this dedups the JS wiring.

## Public surface

- mountRailCollapse(rail, btn) — chevron toggle (was reimplemented 7x).
- mountRailViewToggle(rail, seg) — data/dashboards seg toggle.

## Drift-prone areas

- Per-rail state lives on the rail element via classes (.compact, [data-rail-view]); page CSS reads these.

## Related

- [Frontend pillar landing](../../index.md)
