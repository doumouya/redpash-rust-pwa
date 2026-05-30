---
title: frontend/scripts/pages/login.js
source: ../../../../../frontend/scripts/pages/login.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# login.js

## Purpose

Login page — the RedPash sign-in surface. Leads with the product: upload a CSV, watch RedPash clean it in the browser via WebAssembly. The file never leaves the page. Cleaning summary + 7-row mini-table preview appears under the button. Then sign in: Google OAuth or dev shortcut.

## Public surface

- Default export: page mount.
- Calls getEngine() (wasm-engine) lazily on upload.
- Calls engine.auto_clean(rows); renders summary + minitable.

## Drift-prone areas

- Wasm engine contract — see scripts/wasm-engine.md. Demo deferred work: surface wasm-bench-grade profile data in a bigger modal (per project-landing-csv-demo).

## Related

- [Frontend pillar landing](../../../index.md)
