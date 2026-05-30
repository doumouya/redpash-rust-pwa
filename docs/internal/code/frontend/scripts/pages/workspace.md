---
title: frontend/scripts/pages/workspace.js
source: ../../../../../frontend/scripts/pages/workspace.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# workspace.js

## Purpose

Workspace page — the redtable as a browser, wired to /api. On mount: load real projects + lazy-load files per group. File click fetches columns + page and renders. Toolbar (search, sort, select / edit / delete, columns, filter builder) operates on the loaded page.

## Public surface

- Default export: page mount.
- Mounts Tools panel + Filter panel + Report builder + Designer eagerly.
- Joins tab eager-mounted (2026-05-29).

## Drift-prone areas

- Composes virtually every other frontend module; the deepest single page.

## Related

- [Frontend pillar landing](../../../index.md)
