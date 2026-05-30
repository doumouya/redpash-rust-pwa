---
title: frontend/scripts/pages/monitoring.js
source: ../../../../../frontend/scripts/pages/monitoring.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# monitoring.js

## Purpose

Monitoring — the system telemetry surface. Same shell pattern as Home (rail + body). Static rail groups: REQUESTS / AUDITS / CATALOG. Tabs render observability data (requests, events, runs, findings, steps, charts, optimization, user activity).

## Public surface

- Default export: page mount.
- Per-tab specs from pages/monitoring/tabs.js.
- M-1 request-detail modal: openRequestReplay(rid) reads /api/monitoring/request/:rid.

## Drift-prone areas

- Request-detail modal uses the shared rp-modal-* atom + --rp-modal-w width override.

## Related

- [Frontend pillar landing](../../../index.md)
