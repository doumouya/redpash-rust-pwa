---
title: frontend/scripts/tools/catalog.js
source: ../../../../../frontend/scripts/tools/catalog.js
owner: Torv
section: Internal · Code · Frontend · scripts/tools
last modified date: 2026-05-30
---

# catalog.js

## Purpose

Tools-panel 12-tool catalog — slice 3 of the tools.js decomposition. Each entry is a tool definition consumed by the form-renderer + click handler in tools.js.

## Public surface

- TOOLS — array of tool definitions with { kind, label, icon, blurb, fields, toParams }.
- toParams reads form values into the step params shape.

## Drift-prone areas

- Tool kind + params shape must match server data::steps per-kind expectations.

## Related

- [Frontend pillar landing](../../../index.md)
