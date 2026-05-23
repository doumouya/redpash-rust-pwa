---
title: Audit storage
section: Internal
order: 22
last modified date: 2026-05-24
owner: Gus
status: stub
---

# Audit storage

> **TODO (Gus).** Fill from `tools/audit-storage-*`, `audit_ingest.rs`, and the `audit.run` / `audit.finding` schemas.

To cover:

- The audit suite (`tools/audit.sh`) — what each `tools/*-audit/audit.js` produces
- JSON → ingest pipeline (`redpash-audit-ingest` binary)
- `audit.run` + `audit.finding` schemas + the `audit.run_diff()` SQL function
- "Findings drift over time" — how to read the trend
- When to add a new audit tool (the discipline)
