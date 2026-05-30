---
title: tools/audit.sh
source: ../../../../../tools/audit.sh
owner: Gus / Torv
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# audit.sh — the master runner

## Purpose

Runs every `tools/*-audit/audit.js` in sequence, ingests the ones that
emit `audit.json`, and prints a per-tool "since last run" diff inline.
**Auto-discovers new audits by glob** — a new audit dir is picked up
the day it's added, no edit here. This is the single command
contributors run before commit to see the codebase's static-health
state.

## Public surface

- Discovery: `tools/*-audit/` glob with `audit.js` present.
- Ingest: runs the `redpash-audit-ingest` binary against `audit.json`
  outputs from tools in the `INGEST_TOOLS` allowlist (CHECK-constrained
  on the DB side).
- Sets `cd "$REPO_ROOT"` so the ingest binary's `.env` lookup works.
- Pre-builds the ingest binary once per invocation.

## Drift-prone areas

- **`INGEST_TOOLS` allowlist** must stay in sync with the
  `audit.run.tool` CHECK constraint. A new audit added to one without
  the other regresses ingest.
- **Name resolution** strips `-audit` from the dir basename, then
  strips a leading `css-`. `tools/css-cross-page-audit/` resolves to
  `cross-page`. New audit naming has to play with this rule.

## Related

- [Audit-suite docs](../audit-suite/index.md)
- [Subsystem: audit-storage](../../../subsystems/audit-storage.md)
- [Process: audit-cadence](../../../processes/audit-cadence.md)
- [Spec: audit-storage-design](../../../specs/audit-storage-design.md)
