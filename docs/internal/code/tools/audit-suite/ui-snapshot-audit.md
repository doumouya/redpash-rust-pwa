---
title: tools/ui-snapshot-audit/audit.js
source: ../../../../../tools/ui-snapshot-audit/audit.js
owner: Woz / Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# ui-snapshot-audit

## Purpose

Reads UI snapshot JSONs captured by the frontend's `?audit=1` mode
(`frontend/scripts/audit/snapshot.js` — Layer 2a) from `snapshots/`,
normalises them into a findings list, and emits `audit.json` in the
canonical shape the audit suite ingests through `redpash-audit-ingest`.
Bridges the runtime UI capture into the same `audit.run` / `audit.finding`
tables the static audits land in.

This tool is **atom computed-style drift only** (the `?audit=1` capture). The
separate *component-inventory* concern — the full rendered class set per state,
for the UI-doc / proposition confirmation — is the `?audit=2` capture
(`snapshot.js` `captureInventory()`) cross-checked against the static enumerator
`tools/lib/fe-inventory.js` via `tools/ui-doc-audit`; it does NOT live here.
This tool skips `capture==="inventory"` snapshots.

## Public surface

- Reads `*.json` under `tools/ui-snapshot-audit/snapshots/` (downloaded by the `?audit=1` walker); ignores `?audit=2` inventory captures.
- Emits `audit.json` (atom-style `finding_key`s, ingest-ready).
- Auto-discovered as `ui-snapshot`.

## Drift-prone areas

- **`finding_key` shape** must stay stable across runs (the `audit.run_diff` self-join axis). Encoding value-data in the key breaks diff.
- Prerequires the `redpash-audit-ingest` CHECK + `explode()` to recognise `ui-snapshot` before its findings DB-ingest.
- The atom catalog (computed-style half) must stay in sync with the foundation atoms; new atoms are added in `snapshot.js`.

## Related

- [Audit-suite landing](index.md)
- [Spec: audit-ingest-explode](../../../specs/audit-ingest-explode.md)
- [Frontend snapshot capture: scripts/audit/snapshot.md](../../frontend/scripts/audit/snapshot.md)
- [Master runner: audit.sh](../shell/audit.md)
