---
title: frontend/scripts/main.js
source: ../../../../frontend/scripts/main.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# main.js

## Purpose

Hash-based SPA router. Each route names a partial (HTML fetched into #app) and a script (ES module whose default export mounts onto the node with a ctx). Rebuilt clean 2026-05-22 frontend reset; pages added to ROUTES as the rebuild lands.

## Public surface

- ROUTES registry — route -> { partial, scriptPath, auth? }.
- Boot: fetch /api/me, seed prefs, then route.
- 401 -> redirect to #/login.

## Drift-prone areas

- Route registration shape — adding a page means a ROUTES entry + the partial + the page script.

## Related

- [Frontend pillar landing](../../index.md)
