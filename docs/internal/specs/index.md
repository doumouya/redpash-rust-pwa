---
title: Specs — index
section: Internal
order: 30
last modified date: 2026-05-27
---

# Specs

The **what** — current wire contracts, schemas, surface plans.
Rewritten when the contract changes; superseded versions move to
`archive/`. Each spec is the source of truth for the wire it describes.

| Doc | Owner | What it pins |
|---|---|---|
| [admin-monitoring-surfaces](admin-monitoring-surfaces.md) | Torv | `/home` + `/monitoring` IA, endpoint list, shell pattern shared between them |
| [audit-ingest-explode](audit-ingest-explode.md) | Gus | Per-tool `finding_key` + `severity` + `detail` contract for `redpash-audit-ingest`'s `explode()`. Source of truth for what each `tools/*-audit/audit.js` emits and what each Rust match arm reads. **DRAFT ENTRY — Gus to confirm/rewrite.** |
| [filter-dto](filter-dto.md) | Gus | `FilterNode` / `FilterOp` canonical — workspace filter UI + step engine + wasm wrapper all share |
| [from-row-spike](from-row-spike.md) | Torv | rs-audit-flagged `row.try_get(_)` DTO mapping spike: at what threshold (DTOs migrated) does `sqlx::FromRow` repay its boilerplate cost. Filled — threshold finding recorded. |
| [mcp-memory-bridge](mcp-memory-bridge.md) | Woz | v3 MCP server scope: per-agent vs shared memory partition + conflict-resolution path on top of v1+v2's file-resource bridge. **DRAFT ENTRY — Woz to confirm/rewrite.** |
| [monitoring-schemas](monitoring-schemas.md) | Gus | `events`, `request_log`, `audit.run`, `audit.finding` table shapes + wire projections |
| [optimization-map](optimization-map.md) | Gus | `optimization_points` table + live-measurement evaluator + Monitoring/Optimization tab wire |
| [user-preferences](user-preferences.md) | Gus | `user_preferences` table + PATCH protocol + key registry |
| [wasm-phase-c-spike](wasm-phase-c-spike.md) | Woz | Phase C parse-on-wasm honest perf + size delta; bundle vs first-parse cliff finding that gates Phase D. Filled — clean-dense plateau at ~45 ms/MB, Phase D unlocked. **DRAFT ENTRY — Woz to confirm/rewrite.** |
| [datasource-trait](datasource-trait.md) | Gus | DataSource / Entity / Reader trait sketch for the ETL-ELT workstream. **Status: sketch, no code lands from this doc** — alignment surface before the [[etl-elt-roadmap]] workstream picks it up. |
