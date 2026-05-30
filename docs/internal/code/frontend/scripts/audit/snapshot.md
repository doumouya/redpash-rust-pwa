---
title: frontend/scripts/audit/snapshot.js
source: ../../../../../frontend/scripts/audit/snapshot.js
owner: Torv
section: Internal · Code · Frontend · scripts/audit
last modified date: 2026-05-30
---

# snapshot.js

## Purpose

When the SPA loads with ?audit=1, every page mount triggers captureSnapshot() — walks the rendered DOM, captures getComputedStyle() for the foundation-atom catalog, and downloads a JSON file. Output feeds tools/ui-snapshot-audit/audit.js for ingest.

## Public surface

- captureSnapshot(rootEl) — DOM walk + computed-style harvest + JSON download.
- Foundation-atom catalog (selectors to probe) lives inline.

## Drift-prone areas

- Atom catalog must stay in sync with frontend/styles/ foundation atoms; new atoms need adding here to be captured.

## Related

- [Frontend pillar landing](../../../index.md)
