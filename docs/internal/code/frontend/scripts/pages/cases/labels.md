---
title: frontend/scripts/pages/cases/labels.js
source: ../../../../../../frontend/scripts/pages/cases/labels.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages/cases
last modified date: 2026-05-30
---

# labels.js

## Purpose

Cases page label vocabulary — slice 6 of the god-object decomposition. Pure data, module-private, structural-only extract.

## Public surface

- 7 exports cover the case-state vocabulary: STATUS_ORDER, STATUS_LABEL, PRIORITY_ORDER, PRIORITY_LABEL, TYPE_ORDER, TYPE_LABEL, STATUS_NEXT.

## Drift-prone areas

- Mirrors shared::case::Case enums; backend drift = UI shows stale labels.

## Related

- [Frontend pillar landing](../../../../index.md)
