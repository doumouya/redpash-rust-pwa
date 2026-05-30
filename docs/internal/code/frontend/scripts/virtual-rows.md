---
title: frontend/scripts/virtual-rows.js
source: ../../../../frontend/scripts/virtual-rows.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# virtual-rows.js

## Purpose

Windowed <tbody> renderer for the redtable. Mounts only the rows near the viewport (+overscan); the rest are represented by two spacer <tr>s carrying off-window height so the scrollbar stays honest. DOM node count becomes constant (~visible + overscan).

## Public surface

- mountVirtualRows(tbody, rows, renderRow, opts) — mount + scroll-driven re-window.
- Spacer-tr technique keeps scrollbar geometry correct.

## Drift-prone areas

- Row-height assumption: uniform-height rows. Variable-height needs a per-row measurement pass.

## Related

- [Frontend pillar landing](../../index.md)
