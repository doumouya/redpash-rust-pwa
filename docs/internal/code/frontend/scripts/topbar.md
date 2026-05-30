---
title: frontend/scripts/topbar.js
source: ../../../../frontend/scripts/topbar.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# topbar.js

## Purpose

Topbar — the shared chrome for authed pages. One component, one button pattern: brand · omnibox · nav + theme + sign-out + avatar. A page drops <header id="rp-topbar"> and its script calls mountTopbar(el, { active, session }).

## Public surface

- mountTopbar(el, { active, session }) — paints brand + omnibox + nav.
- Omnisearch dropdown reads /api/search.

## Drift-prone areas

- Every authed page renders the identical topbar; new nav entries need this single change.

## Related

- [Frontend pillar landing](../../index.md)
