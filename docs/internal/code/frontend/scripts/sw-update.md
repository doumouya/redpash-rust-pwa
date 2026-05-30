---
title: frontend/scripts/sw-update.js
source: ../../../../frontend/scripts/sw-update.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# sw-update.js

## Purpose

Service-worker registration. The SW exists for ONE reason: keep RedPash installable as a desktop PWA. It does no caching, so there is no stale-asset situation and therefore no new-version banner.

## Public surface

- registerSW() — registers /service-worker.js on load.
- skipWaiting + clients.claim in the worker = silent updates.

## Drift-prone areas

- Path to /service-worker.js is absolute; relocation breaks installability.

## Related

- [Frontend pillar landing](../../index.md)
