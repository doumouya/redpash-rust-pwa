---
title: frontend/scripts/sw-update.js
source: ../../../../frontend/scripts/sw-update.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# sw-update.js

## Purpose

Service-worker registration. The SW keeps RedPash installable as a desktop PWA AND cache-first-serves the content-hashed wasm engine (`/wasm/data_bg.<hash>.wasm`) for instant repeat loads + offline edge-compute. It caches ONLY the immutable-hashed wasm — no JS/CSS — so there's still no stale-asset situation and no new-version banner; the hash (from `tools/build-wasm.sh`) is the cache version, so there's never a manual `CACHE_VERSION` bump. See `frontend/service-worker.js`.

## Public surface

- registerSW() — registers /service-worker.js on load.
- skipWaiting + clients.claim in the worker = silent updates.

## Drift-prone areas

- Path to /service-worker.js is absolute; relocation breaks installability.

## Related

- [Frontend pillar landing](../../index.md)
