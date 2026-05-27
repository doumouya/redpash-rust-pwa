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
| [mcp-memory-bridge](mcp-memory-bridge.md) | Woz | v3 of the MCP server (Torv-26.04 lane). Two design calls that v1+v2's file-resource bridge doesn't decide for free: (1) shared vs per-agent memory partition via a `share:` frontmatter override on top of the existing `type:` taxonomy (feedback / project / reference default shared, user defaults per-agent, individual memories can opt-out); (2) audit-on-conflict resolution (Em as resolver) over last-write-wins, treating same-name divergence as a convergence signal rather than a merge problem. Designed-not-built; v3 implementation owns the build. |
| [monitoring-schemas](monitoring-schemas.md) | Gus | `events`, `request_log`, `audit.run`, `audit.finding` table shapes + wire projections |
| [optimization-map](optimization-map.md) | Gus | `optimization_points` table + live-measurement evaluator + Monitoring/Optimization tab wire |
| [user-preferences](user-preferences.md) | Gus | `user_preferences` table + PATCH protocol + key registry |
| [wasm-phase-c-spike](wasm-phase-c-spike.md) | Woz | Phase C parse-on-wasm: honest perf + size delta against the `roadmap-webassembly.md` §5 gate (10 MB bundle / 4 s first-parse parks Phase C; 2 MB / 200 ms unlocks Phase D). **Verdict: gate cleared** — ~45 ms/MB clean-dense plateau on 13–21 MB corpora, ~3.45 MB gzipped bundle, parse algorithm bakes in `unwrap_csv` rescue per the spike's correctness finding. Phase D unlocked. Addendum tracks two verdict-refining sub-cliffs (sparse-wide allocator pressure on rescue path past 100k rows; legacy-encoded windows-1252 + malformed-wrap handling). |
| [datasource-trait](datasource-trait.md) | Gus | DataSource / Entity / Reader trait sketch for the ETL-ELT workstream. **Status: sketch, no code lands from this doc** — alignment surface before the [[etl-elt-roadmap]] workstream picks it up. |
