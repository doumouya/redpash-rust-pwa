---
title: frontend/scripts/events.js
source: ../../../../frontend/scripts/events.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# events.js

## Purpose

Frontend event capture. Phase 2 of the Events system. Captures what the backend capture_mw middleware structurally cannot see: uncaught JS exceptions, unhandled promise rejections, page-mount lifecycle, audit-flagged anomalies.

## Public surface

- Listens on window:error, window:unhandledrejection, custom audit events.
- POSTs to /api/events with correlation request_id from the last api call.

## Drift-prone areas

- Wire shape — shared::event::Event. Field drift breaks ingest.

## Related

- [Frontend pillar landing](../../index.md)
