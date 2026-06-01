---
title: frontend/scripts/virtual-rows.js
source: ../../../../frontend/scripts/virtual-rows.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# virtual-rows.js

## Purpose

Windowed <tbody> renderer for the redtable. Mounts only the rows near the viewport (+overscan); the rest are represented by spacer <tr>s carrying off-window height so the scrollbar stays honest. DOM node count becomes constant (~visible + overscan).

Beyond ~262k comfortable-density rows the *exact* spacer would push the scroll OFFSET past **2^24 px (16.7M)** — the float32 compositor limit, where rows paint blurry/mispositioned even though layout + index math stay correct (CAS_21B43BEC: the grid "went weird" ~row 261k on a 431k file at ~64px rows). So the scroller caps its real scrollable height at `MAX_SCROLL_PX` (12M, safely under 2^24) and, for taller content, runs in **SCALED mode**: the capped scroll range maps proportionally onto the row range, with sub-row positioning so it still scrolls smoothly. Below the cap it's exact, native 1:1 scroll (unchanged).

## Public surface

- `createVirtualRows({ scroller, tbody, rowHeight, renderRow, overscan?, pauseWhile? })` → `{ setRows, refresh, remeasure, rowHeight, destroy }`.
- Spacer-tr technique keeps scrollbar geometry correct; `geometry()` computes the window + top/bottom spacer heights (exact or scaled) so painted pixels stay < 2^24.

## Drift-prone areas

- Row-height assumption: uniform-height rows. Variable-height needs a per-row measurement pass.
- `MAX_SCROLL_PX` must stay below 2^24 (float32 compositor limit); scaled mode trades exact scroll *speed* (more rows per pixel) for correct painting at arbitrary row counts — verified to 431k.

## Related

- [Frontend pillar landing](../../index.md)
