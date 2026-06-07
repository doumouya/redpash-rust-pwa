---
title: frontend/scripts/main.js
source: ../../../../frontend/scripts/main.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-07
---

# main.js

## Purpose

Hash-based SPA router. Each route names a partial (HTML fetched into #app) and a script (ES module whose default export mounts onto the node with a ctx). Rebuilt clean 2026-05-22 frontend reset; pages added to ROUTES as the rebuild lands.

## Public surface

- ROUTES registry — route -> { partial, scriptPath, auth?, admin? }.
- Boot: fetch /api/me, seed prefs, then route.
- 401 -> redirect to #/login.
- `admin: true` routes (Monitoring + **`/admin-console`** — the latter added Slice B,
  2026-06-07 — CAS_274EDF3B) bounce a non-admin
  (`!session?.is_platform_admin`) to #/home after the `auth` check — guards a
  direct hash deep-link. UX gate; the backend `require_platform_admin_mw` is the
  real auth.

## Drift-prone areas

- Route registration shape — adding a page means a ROUTES entry + the partial + the page script.

## Related

- [Frontend pillar landing](../../index.md)
- [pages/sheetwise.js](pages/sheetwise.md) — the `/sheetwise` route (added 2026-06-05;
  replaced the standalone `frontend/sheetwise.html`).
- [pages/dashboard.js](pages/dashboard.md) — the `/dashboard` route (added 2026-06-07,
  Slice D / D1; the standalone chart + dashboard designer split out of the Workspace page).
