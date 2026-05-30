---
title: Observability — index
section: Observability
order: 0
last modified date: 2026-05-30
---

# Observability

The runtime/dynamic side of observability — `events` capture,
`request_log` per-request rows, `db_query_log` per-query timing,
investigation playbooks. Pairs with the **static** observability
(the [audit suite](../code/tools/audit-suite/index.md)) the audit
discipline encodes: this dir captures what happens at runtime; the
audit suite catches what's wrong before runtime.

## Documents

| Doc | Purpose |
|---|---|
| [db-monitoring.md](db-monitoring.md) | the `db_query_log` table + `REDPASH_DB_TRACE` toggle + query-template extraction; runtime DB-query observability |
| [investigations.md](investigations.md) | playbook for using `events` + `request_log` to investigate a production incident |

## Related

- [Audit suite](../code/tools/audit-suite/index.md) — the static half of observability (drift detection)
- [Subsystem: audit-storage](../subsystems/audit-storage.md) — how audit findings persist for trend analysis
- [Subsystem: events-and-logs](../subsystems/events-and-logs.md) — the events + request_log capture pipeline
- [Spec: monitoring-schemas](../specs/monitoring-schemas.md) — the wire shapes
- [Spec: optimization-map](../specs/optimization-map.md) — `optimization_points` + live-measurement evaluator
