---
title: tools/observability-audit/audit.js
source: ../../../../../tools/observability-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# observability-audit

## Purpose

The meta-audit — slice A of the *audit-everything* workstream.
Cross-stack catalog of every observability primitive currently wired
in the app. Answers: *"what does the system record about itself,
where, how much?"* Output drives the workflow / gap analysis at
[`docs/internal/observability/investigations.md`](../../../observability/investigations.md)
— what we can trace today, what we can't.

## Public surface

- Categories (mirror the operator's investigation surface):
  - request-level (request_log + capture middleware + request_id)
  - event-level (event::record sites + Channel A/B split)
  - DB-level (db_query_log + REDPASH_DB_TRACE)
  - audit-level (audit.run / audit.finding ingest)
  - error-level (AppError + tracing::error sites)
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `observability`.

## Drift-prone areas

- **Primitive detection** is regex over Rust + JS source; new observability shapes need adding to the recognised set.
- **Category counts** are the headline metric; if a primitive is wired but undetected, the audit under-reports.

## Related

- [Audit-suite landing](index.md)
- [Observability section](../../../observability/index.md) — runtime visibility (pairs with this audit's static catalog)
- [Subsystem: audit-storage](../../../subsystems/audit-storage.md)
- [Master runner: audit.sh](../shell/audit.md)
