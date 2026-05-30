---
title: frontend/scripts/rail-footer.js
source: ../../../../frontend/scripts/rail-footer.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# rail-footer.js

## Purpose

Rail footer nav — shared utility cluster (Docs / Settings / Profile) living at the bottom of every railed page rt-nav-foot. Relocated out of the topbar 2026-05-28 (VS-Code / Slack style).

## Public surface

- mountRailFooterNav(footEl, { active, session }) — paints the 3 utility entries.
- active names which entry is current page.

## Drift-prone areas

- Active-entry styling depends on CSS sibling rules; adding a 4th entry needs CSS support.

## Related

- [Frontend pillar landing](../../index.md)
