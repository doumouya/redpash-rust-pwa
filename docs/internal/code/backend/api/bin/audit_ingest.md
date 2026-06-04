---
title: backend/crates/api/src/bin/audit_ingest.rs
source: ../../../../../../backend/crates/api/src/bin/audit_ingest.rs
owner: Gus
section: Internal · Code · backend · api · bin
last modified date: 2026-06-03
---

# audit_ingest.rs

## Purpose

`redpash-audit-ingest` — persist one tools/<tool>-audit/audit.json
run into audit.run + audit.finding.

Standalone companion to the audit scripts. Each `audit.js` writes its
full `data` object as `audit.json` next to the .html report; this
binary reads that JSON, captures git context, and writes one
`audit.run` row + one `audit.finding` row per individual finding in a
single transaction.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- The `ALLOWED` tool list + each `explode()` arm must stay in sync with the
  `audit.run.tool` CHECK constraint (baseline init.sql + the relax migrations).
  Tools with an explode arm: `css`, `html`, `ui-snapshot`, **`api-doc`** (2026-06-03 —
  string severity high/med/low → 3/2/1; keys are stable METHOD-path / surface labels);
  `tab-compare`/`cross-page`/`parallel` are CHECK-accepted stubs (0 findings).
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
