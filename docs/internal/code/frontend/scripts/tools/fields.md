---
title: frontend/scripts/tools/fields.js
source: ../../../../../frontend/scripts/tools/fields.js
owner: Torv
section: Internal · Code · Frontend · scripts/tools
last modified date: 2026-05-30
---

# fields.js

## Purpose

Tools-panel field-type renderers — first slice of the tools.js decomposition. Each renderer returns { html, read(rootEl) }. read returns the typed value; the parent tool config composes them.

## Public surface

- 5 renderers: column, enum, text, boolean, multicolumn.
- Each: (field) => { html, read(root) }.

## Drift-prone areas

- Field types map to step params shape; adding a new type needs a renderer + catalog update.

## Related

- [Frontend pillar landing](../../../index.md)
