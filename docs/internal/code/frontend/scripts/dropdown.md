---
title: frontend/scripts/dropdown.js
source: ../../../../frontend/scripts/dropdown.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# dropdown.js

## Purpose

One delegated click handler for the [data-dd] + .rt-dd dropdown atom. Replaces the mount-time $$([data-dd]) sweep in workspace.js (only caught statically-rendered buttons) + the inline workaround in report.js.

## Public surface

- mountDropdowns(root) — single delegated handler (root-relative).
- Closes on outside-click and Escape.

## Drift-prone areas

- Atom contract: [data-dd] button + sibling .rt-dd panel. New dropdown markup must follow this pattern or it will not open.

## Related

- [Frontend pillar landing](../../index.md)
