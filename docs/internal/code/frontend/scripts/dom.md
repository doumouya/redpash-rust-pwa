---
title: frontend/scripts/dom.js
source: ../../../../frontend/scripts/dom.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# dom.js

## Purpose

DOM utility primitives shared across every page that renders HTML strings. Extracted from 9 duplicate copies (audit 2026-05-24: esc x9, cssEsc x3, escHTML x2) so a bug fix in one place flows to every surface.

## Public surface

- esc(s) — HTML-attr / text escape; the canonical version.
- cssEsc(s) — CSS-attr escape.
- escHTML(s) — alias preserved for compat.

## Drift-prone areas

- Used by literally every page render code; any signature change is breaking.

## Related

- [Frontend pillar landing](../../index.md)
