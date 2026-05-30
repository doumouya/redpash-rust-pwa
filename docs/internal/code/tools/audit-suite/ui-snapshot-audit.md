---
title: tools/ui-snapshot-audit/audit.js
source: ../../../../../tools/ui-snapshot-audit/audit.js
owner: Woz / Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# ui-snapshot-audit

## Purpose

Reads UI snapshot JSONs captured by the frontend's `?audit=1` mode
(`frontend/scripts/audit/snapshot.js` — Layer 2a), normalises them
into a findings list, and emits `audit.json` in the canonical shape
the audit suite ingests through `redpash-audit-ingest`. Bridges the
runtime UI capture into the same `audit.run` / `audit.finding` tables
the static audits land in.

## Public surface

- Reads `audit.snapshots` (Postgres) — populated by the `?audit=1` capture middleware.
- Emits `audit.json` keyed by `finding_key` per the [audit-ingest-explode spec](../../../specs/audit-ingest-explode.md).
- Auto-discovered as `ui-snapshot`.

## Drift-prone areas

- **`finding_key` shape** must stay stable across runs (the `audit.run_diff` self-join axis). Encoding value-data in the key breaks diff.
- The audit prerequires the `redpash-audit-ingest` binary's CHECK + `explode()` to recognise `ui-snapshot` — relax the CHECK before adding new tool kinds.

## Related

- [Audit-suite landing](index.md)
- [Spec: audit-ingest-explode](../../../specs/audit-ingest-explode.md)
- [Frontend snapshot capture: scripts/audit/snapshot.md](../../frontend/scripts/audit/snapshot.md)
- [Master runner: audit.sh](../shell/audit.md)
