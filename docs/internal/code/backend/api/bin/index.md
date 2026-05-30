---
title: Internal · Code · Backend · api/bin — atomic docs
section: Internal · Code · Backend · api · bin
order: 5
last modified date: 2026-05-30
---

# api/bin — atomic docs

Maintenance binaries that ship alongside the API but run as one-shot
tools (cargo invokes them via `--bin <name>`). They share the api
crate's deps (sqlx, Postgres connection, AppState pieces) so they can
talk to the same DB without spinning up a separate connection layer.

**Coverage at baseline (2026-05-30):** 2 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `audit_ingest.rs` | [audit_ingest.md](audit_ingest.md) | reads `tools/*-audit/audit.json` outputs, inserts `audit.run` + `audit.finding` rows |
| `audit_distincts.rs` | [audit_distincts.md](audit_distincts.md) | one-shot distinct-value scan; feeds the cleanness vocabulary |

## Related

- [Crate landing](../index.md)
- [Subsystem: audit-storage](../../../../subsystems/audit-storage.md)
- [Spec: audit-ingest-explode](../../../../specs/audit-ingest-explode.md)
