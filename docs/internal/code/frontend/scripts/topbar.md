---
title: frontend/scripts/topbar.js
source: ../../../../frontend/scripts/topbar.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-05
---

# topbar.js

## Purpose

Topbar — the shared chrome for authed pages. One component, one button pattern: brand · omnibox · nav + theme + sign-out + avatar. A page drops <header id="rp-topbar"> and its script calls mountTopbar(el, { active, session }).

## Public surface

- mountTopbar(el, { active, session }) — paints brand + omnibox + nav.
- Omnisearch dropdown reads /api/search.

## Drift-prone areas

- Every authed page renders the identical topbar; new nav entries need this single change.
  The current `NAV`: Home · Workspace · **SheetWise** (`bi-database`, added 2026-06-05) ·
  Cases · Monitoring (admin-only).
- **Admin-only nav entries (`admin: true`)** are filtered out for non-admins
  (`NAV.filter((n) => !n.admin || session?.is_platform_admin)`). Monitoring is
  the only one today (CAS_274EDF3B) — members/viewers never see the link; the
  `main.js` route guard + the backend `require_platform_admin_mw` are the
  companions (URL deep-link + real auth).

## Related

- [Frontend pillar landing](../../index.md)
